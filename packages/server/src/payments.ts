import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const CyberSource = require("cybersource-rest-client") as Record<string, new (...args: any[]) => any>;

export type PaymentResult = { id: string; status: string };
export type PaymentInput = {
  amountCents: number;
  currency: "USD";
  reference: string;
  firstName: string;
  lastName: string;
};

export interface PaymentGateway {
  readonly provider: "CYBERSOURCE";
  readonly environment: "SANDBOX";
  authorize(input: PaymentInput): Promise<PaymentResult>;
  capture(authorizationId: string, input: Pick<PaymentInput, "amountCents" | "currency" | "reference">): Promise<PaymentResult>;
  reverse(authorizationId: string, input: Pick<PaymentInput, "amountCents" | "reference">): Promise<PaymentResult>;
}

export type CyberSourceConfig = {
  authenticationType?: "jwt" | "http_signature";
  merchantId: string;
  keyId: string;
  secretKey: string;
  cardNumber: string;
  cardExpirationMonth: string;
  cardExpirationYear: string;
  cardSecurityCode?: string;
  billToAddress1: string;
  billToLocality: string;
  billToAdministrativeArea: string;
  billToPostalCode: string;
  billToCountry: string;
  billToEmail: string;
  billToPhone: string;
  mlePublicCertificatePath?: string;
};

type GatewayResponse = { status?: number; text?: string };
type GatewayError = { status?: number; response?: GatewayResponse };
type Callback = (error: GatewayError | Error | undefined, data: Record<string, unknown> | undefined, response: GatewayResponse | undefined) => void;

const dollars = (cents: number) => (cents / 100).toFixed(2);

function call(run: (callback: Callback) => void): Promise<{ data: Record<string, unknown>; status: number }> {
  return new Promise((resolve, reject) => {
    run((error, data, response) => {
      if (error || !data || !response?.status || response.status < 200 || response.status >= 300) {
        const errorStatus = response?.status ?? (error && "status" in error ? error.status : undefined);
        const raw = error && "response" in error ? error.response?.text : response?.text;
        let detail = "";
        try {
          const body = raw ? JSON.parse(raw) as Record<string, unknown> : undefined;
          const errorInformation = body?.errorInformation && typeof body.errorInformation === "object" ? body.errorInformation as Record<string, unknown> : undefined;
          const fields = [body?.status, body?.reason, body?.message, errorInformation?.reason, errorInformation?.message]
            .filter((value): value is string => typeof value === "string" && value.length > 0);
          const requestId = typeof body?.id === "string" && body.id.length > 0 ? ` [request ${body.id}]` : "";
          detail = `${fields.length ? `: ${[...new Set(fields)].join(" — ").slice(0, 500)}` : ""}${requestId}`;
        } catch { /* The gateway sometimes returns an empty or non-JSON upstream error. */ }
        const status = errorStatus ? ` (${errorStatus})` : "";
        reject(new Error(`CYBERSOURCE_REQUEST_FAILED${status}${detail}`));
        return;
      }
      resolve({ data, status: response.status });
    });
  });
}

function result(data: Record<string, unknown>): PaymentResult {
  const id = typeof data.id === "string" ? data.id : "";
  const status = typeof data.status === "string" ? data.status : "";
  if (!id || !status) throw new Error("CYBERSOURCE_INVALID_RESPONSE");
  return { id, status };
}

/** Real CyberSource test-gateway adapter. Test transactions appear in Business Center. */
export class CyberSourceGateway implements PaymentGateway {
  readonly provider = "CYBERSOURCE" as const;
  readonly environment = "SANDBOX" as const;
  readonly #merchant: Record<string, unknown>;

  constructor(readonly config: CyberSourceConfig) {
    const authenticationType = config.authenticationType ?? "jwt";
    this.#merchant = {
      authenticationType,
      ...(authenticationType === "jwt" ? { jwtKeyType: "SHARED_SECRET" } : {}),
      merchantID: config.merchantId,
      merchantKeyId: config.keyId,
      merchantsecretKey: config.secretKey,
      runEnvironment: "apitest.cybersource.com",
      logConfiguration: { enableLog: false, enableMasking: true },
      ...(config.mlePublicCertificatePath ? { enableRequestMLEForOptionalApisGlobally: true, mleForRequestPublicCertPath: config.mlePublicCertificatePath } : {}),
    };
  }

  async authorize(input: PaymentInput) {
    const request = new CyberSource.CreatePaymentRequest();
    request.clientReferenceInformation = Object.assign(new CyberSource.Ptsv2paymentsClientReferenceInformation(), { code: input.reference });
    request.processingInformation = Object.assign(new CyberSource.Ptsv2paymentsProcessingInformation(), { capture: false });
    const card = Object.assign(new CyberSource.Ptsv2paymentsPaymentInformationCard(), {
      number: this.config.cardNumber,
      expirationMonth: this.config.cardExpirationMonth,
      expirationYear: this.config.cardExpirationYear,
      ...(this.config.cardSecurityCode ? { securityCode: this.config.cardSecurityCode } : {}),
    });
    request.paymentInformation = Object.assign(new CyberSource.Ptsv2paymentsPaymentInformation(), { card });
    const amountDetails = Object.assign(new CyberSource.Ptsv2paymentsOrderInformationAmountDetails(), { totalAmount: dollars(input.amountCents), currency: input.currency });
    const billTo = Object.assign(new CyberSource.Ptsv2paymentsOrderInformationBillTo(), {
      firstName: input.firstName,
      lastName: input.lastName,
      address1: this.config.billToAddress1,
      locality: this.config.billToLocality,
      administrativeArea: this.config.billToAdministrativeArea,
      postalCode: this.config.billToPostalCode,
      country: this.config.billToCountry,
      email: this.config.billToEmail,
      phoneNumber: this.config.billToPhone,
    });
    request.orderInformation = Object.assign(new CyberSource.Ptsv2paymentsOrderInformation(), { amountDetails, billTo });
    const api = new CyberSource.PaymentsApi(this.#merchant, new CyberSource.ApiClient());
    const response = await call(callback => api.createPayment(request, callback));
    const payment = result(response.data);
    if (payment.status !== "AUTHORIZED") throw new Error(`CYBERSOURCE_AUTH_${payment.status || "DECLINED"}`);
    return payment;
  }

  async capture(authorizationId: string, input: Pick<PaymentInput, "amountCents" | "currency" | "reference">) {
    const request = new CyberSource.CapturePaymentRequest();
    request.clientReferenceInformation = Object.assign(new CyberSource.Ptsv2paymentsClientReferenceInformation(), { code: input.reference });
    const amountDetails = Object.assign(new CyberSource.Ptsv2paymentsidcapturesOrderInformationAmountDetails(), { totalAmount: dollars(input.amountCents), currency: input.currency });
    request.orderInformation = Object.assign(new CyberSource.Ptsv2paymentsidcapturesOrderInformation(), { amountDetails });
    const api = new CyberSource.CaptureApi(this.#merchant, new CyberSource.ApiClient());
    const response = await call(callback => api.capturePayment(request, authorizationId, callback));
    return result(response.data);
  }

  async reverse(authorizationId: string, input: Pick<PaymentInput, "amountCents" | "reference">) {
    const request = new CyberSource.AuthReversalRequest();
    request.clientReferenceInformation = Object.assign(new CyberSource.Ptsv2paymentsidreversalsClientReferenceInformation(), { code: input.reference });
    const amountDetails = Object.assign(new CyberSource.Ptsv2paymentsidreversalsReversalInformationAmountDetails(), { totalAmount: dollars(input.amountCents) });
    request.reversalInformation = Object.assign(new CyberSource.Ptsv2paymentsidreversalsReversalInformation(), { amountDetails, reason: "Accord booking was not completed" });
    const api = new CyberSource.ReversalApi(this.#merchant, new CyberSource.ApiClient());
    const response = await call(callback => api.authReversal(authorizationId, request, callback));
    return result(response.data);
  }
}

export function cyberSourceFromEnv(env: NodeJS.ProcessEnv): CyberSourceGateway | undefined {
  const required = ["CYBERSOURCE_MERCHANT_ID", "CYBERSOURCE_KEY_ID", "CYBERSOURCE_SECRET_KEY", "CYBERSOURCE_TEST_CARD_NUMBER", "CYBERSOURCE_TEST_CARD_EXPIRY_MONTH", "CYBERSOURCE_TEST_CARD_EXPIRY_YEAR"] as const;
  if (required.some(key => !env[key])) return undefined;
  return new CyberSourceGateway({
    authenticationType: env.CYBERSOURCE_AUTHENTICATION_TYPE === "http_signature" ? "http_signature" : "jwt",
    merchantId: env.CYBERSOURCE_MERCHANT_ID!, keyId: env.CYBERSOURCE_KEY_ID!, secretKey: env.CYBERSOURCE_SECRET_KEY!,
    cardNumber: env.CYBERSOURCE_TEST_CARD_NUMBER!, cardExpirationMonth: env.CYBERSOURCE_TEST_CARD_EXPIRY_MONTH!, cardExpirationYear: env.CYBERSOURCE_TEST_CARD_EXPIRY_YEAR!,
    cardSecurityCode: env.CYBERSOURCE_TEST_CARD_SECURITY_CODE,
    billToAddress1: env.CYBERSOURCE_TEST_BILL_TO_ADDRESS1 ?? "1 Market St",
    billToLocality: env.CYBERSOURCE_TEST_BILL_TO_CITY ?? "San Francisco",
    billToAdministrativeArea: env.CYBERSOURCE_TEST_BILL_TO_STATE ?? "CA",
    billToPostalCode: env.CYBERSOURCE_TEST_BILL_TO_POSTAL_CODE ?? "94105",
    billToCountry: env.CYBERSOURCE_TEST_BILL_TO_COUNTRY ?? "US",
    billToEmail: env.CYBERSOURCE_TEST_BILL_TO_EMAIL ?? "sandbox@example.com",
    billToPhone: env.CYBERSOURCE_TEST_BILL_TO_PHONE ?? "4158880000",
    mlePublicCertificatePath: env.CYBERSOURCE_MLE_PUBLIC_CERT_PATH,
  });
}

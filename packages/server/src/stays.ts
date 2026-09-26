import { createHash } from "node:crypto";
import { OfferSchema, type Offer, type Trip } from "@accord/domain";

/** Live stay providers. Everything here maps provider data into the domain Offer; feasibility stays in @accord/domain. */
export type Fetch = typeof fetch;
export type StayResearch = { sourceLabel: string; pros: string[]; cons: string[]; nearby: string[]; summary?: string };
export type LiveStay = { offer: Offer; research: StayResearch; ref: LiteRef | ExternalRef };
export type LiteRef = { provider: "LITEAPI"; hotelId: string; offerId: string; roomName: string; refundableTag: string };
export type ExternalRef = { provider: "GOOGLE_HOTELS"; propertyToken: string };
export type ProviderResult = { provider: "LITEAPI" | "GOOGLE_HOTELS"; status: "OK" | "UNCONFIGURED" | "FAILED"; count: number; detail?: string };

const LITE_DATA = "https://api.liteapi.travel/v3.0";
const LITE_BOOK = "https://book.liteapi.travel/v3.0";
const OFFER_TTL_MS = 6 * 60 * 60 * 1000;
const shortHash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 12);
const cents = (dollars: number) => Math.round(dollars * 100);

/** Wall-clock time at the destination → UTC instant. Accepts "11:00 AM", "3:00 PM", "11:00". */
export function localToInstant(date: string, time: string, timeZone: string) {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*([AaPp])?\.?[Mm]?\.?$/.exec(time.trim());
  if (!match) throw new Error("INVALID_TIME");
  let hour = Number(match[1]) % 12 + (match[3] && /p/i.test(match[3]) ? 12 : 0);
  if (!match[3]) hour = Number(match[1]);
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const wall = Date.UTC(y, m - 1, d, hour, Number(match[2] ?? 0));
  const offsetAt = (instant: number) => {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(instant)).map(part => [part.type, part.value]));
    return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second)) - instant;
  };
  let instant = wall - offsetAt(wall);
  instant = wall - offsetAt(instant);
  return new Date(instant).toISOString();
}

async function getJson(fetcher: Fetch, url: string, init: RequestInit, timeoutMs: number) {
  const response = await fetcher(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const body = await response.json().catch(() => ({})) as any;
  if (!response.ok || body?.error) throw new Error(`HTTP_${response.status}${body?.error?.message ? `: ${String(body.error.message).slice(0, 120)}` : ""}`);
  return body;
}

async function pool<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>) {
  const results: R[] = []; let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await run(items[index]!); }
  }));
  return results;
}

// ---------- LiteAPI (bookable hotels, sandbox) ----------

type LiteRate = { name?: string; boardName?: string; maxOccupancy?: number; retailRate?: { total?: Array<{ amount: number; currency: string }> };
  cancellationPolicies?: { refundableTag?: string; cancelPolicyInfos?: Array<{ cancelTime?: string }> } };
type LiteRoomType = { offerId: string; rates: LiteRate[] };

function liteRateSummary(roomType: LiteRoomType) {
  const rate = roomType.rates?.[0];
  const total = rate?.retailRate?.total?.[0];
  if (!rate || !total || total.currency !== "USD") return undefined;
  return { offerId: roomType.offerId, roomName: (rate.name ?? "Room").trim(), board: rate.boardName, totalCents: cents(total.amount),
    refundableTag: rate.cancellationPolicies?.refundableTag ?? "NRFN", cancelTime: rate.cancellationPolicies?.cancelPolicyInfos?.[0]?.cancelTime,
    maxOccupancy: rate.maxOccupancy ?? 0 };
}

export class LiteApi {
  constructor(private readonly key: string, private readonly fetcher: Fetch = fetch) {}
  #headers() { return { "X-API-Key": this.key, "content-type": "application/json", accept: "application/json" }; }

  async rates(trip: Trip, filter: { hotelIds?: string[]; limit?: number }) {
    const body = { ...(filter.hotelIds ? { hotelIds: filter.hotelIds } : { cityName: trip.destination.split(",")[0]!.trim(), countryCode: trip.countryCode }),
      checkin: trip.checkIn, checkout: trip.checkOut, currency: "USD", guestNationality: trip.countryCode,
      occupancies: [{ adults: trip.guests }], maxRatesPerHotel: filter.hotelIds ? 200 : 20, timeout: 10, limit: filter.limit ?? 20, includeHotelData: true };
    return await getJson(this.fetcher, `${LITE_DATA}/hotels/rates`, { method: "POST", headers: this.#headers(), body: JSON.stringify(body) }, 25_000) as
      { data?: Array<{ hotelId: string; roomTypes: LiteRoomType[] }>; hotels?: Array<{ id: string; name: string; main_photo?: string; address?: string; rating?: number; review_count?: number }> };
  }

  async hotel(hotelId: string) {
    return (await getJson(this.fetcher, `${LITE_DATA}/data/hotel?hotelId=${encodeURIComponent(hotelId)}`, { headers: this.#headers() }, 15_000)).data as any;
  }

  async search(trip: Trip, now = new Date()): Promise<LiveStay[]> {
    const rates = await this.rates(trip, {});
    const hotelsById = new Map((rates.hotels ?? []).map(hotel => [hotel.id, hotel]));
    const candidates = (rates.data ?? []).slice(0, 15);
    const details = await pool(candidates, 4, hotel => this.hotel(hotel.hotelId).catch(() => undefined));
    const stays: LiveStay[] = [];
    candidates.forEach((hotel, index) => {
      const summaries = hotel.roomTypes.map(liteRateSummary).filter((item): item is NonNullable<typeof item> => !!item && item.maxOccupancy >= trip.guests);
      // Keep the cheapest refundable and the cheapest non-refundable rate so every refund requirement has a real candidate.
      const picks = ["RFN", "NRFN"].map(tag => summaries.filter(item => item.refundableTag === tag).sort((a, b) => a.totalCents - b.totalCents)[0]).filter(Boolean);
      for (const pick of picks) {
        const stay = mapLite(trip, hotel.hotelId, pick!, details[index], hotelsById.get(hotel.hotelId), now);
        if (stay) stays.push(stay);
      }
    });
    return stays;
  }

  /** Current price and terms for the exact room/rate the group approved. */
  async requote(trip: Trip, ref: LiteRef) {
    const rates = await this.rates(trip, { hotelIds: [ref.hotelId] });
    const summaries = (rates.data?.[0]?.roomTypes ?? []).map(liteRateSummary).filter(Boolean) as Array<NonNullable<ReturnType<typeof liteRateSummary>>>;
    return summaries.filter(item => item.roomName === ref.roomName && item.refundableTag === ref.refundableTag).sort((a, b) => a.totalCents - b.totalCents)[0];
  }

  async prebook(offerId: string) {
    const body = await getJson(this.fetcher, `${LITE_BOOK}/rates/prebook`, { method: "POST", headers: this.#headers(), body: JSON.stringify({ offerId, usePaymentSdk: false }) }, 30_000);
    const data = body.data ?? body;
    return { prebookId: String(data.prebookId), priceCents: cents(Number(data.price)), currency: String(data.currency), cancellationChanged: Boolean(data.cancellationChanged) };
  }

  async book(input: { prebookId: string; firstName: string; lastName: string; email: string; clientReference: string }) {
    const person = { firstName: input.firstName, lastName: input.lastName, email: input.email };
    const body = await getJson(this.fetcher, `${LITE_BOOK}/rates/book`, { method: "POST", headers: this.#headers(), body: JSON.stringify({
      prebookId: input.prebookId, clientReference: input.clientReference, holder: { ...person, phone: "+10000000000" },
      guests: [{ occupancyNumber: 1, ...person }],
      payment: { method: "ACC_CREDIT_CARD" }, // LiteAPI sandbox: simulates payment, nothing is charged.
    }) }, 45_000);
    const data = body.data ?? body;
    return { bookingId: String(data.bookingId), status: String(data.status), hotelConfirmationCode: data.hotelConfirmationCode ? String(data.hotelConfirmationCode) : undefined, priceCents: cents(Number(data.price)) };
  }
}

function mapLite(trip: Trip, hotelId: string, rate: NonNullable<ReturnType<typeof liteRateSummary>>, detail: any, listing: any, now: Date): LiveStay | undefined {
  const facilities: string[] = [...(detail?.hotelFacilities ?? []), ...(detail?.facilities ?? []).map((item: any) => typeof item === "string" ? item : item?.name ?? "")];
  const stepFree = detail?.accessibility?.certificateId || facilities.some(item => /wheelchair accessible|facilities for disabled/i.test(item)) ? true : null;
  const poi: Array<{ name: string; distanceKm: number; importance?: string; category?: string }> = Array.isArray(detail?.poi) ? detail.poi : [];
  const sentiment = detail?.sentiment_analysis ?? {};
  const locationScore = Number((sentiment.categories ?? []).find((item: any) => /location/i.test(item?.name))?.rating ?? 0);
  const cancelBy = rate.refundableTag === "RFN" && rate.cancelTime ? new Date(`${rate.cancelTime.replace(" ", "T")}Z`) : undefined;
  // A refund window that has already closed is, for the group, non-refundable.
  const deadline = cancelBy && cancelBy.getTime() > now.getTime() ? cancelBy : undefined;
  const refundable = !!deadline;
  const checkOut = String(detail?.checkinCheckoutTimes?.checkout || "12:00 PM");
  const checkIn = String(detail?.checkinCheckoutTimes?.checkin_start || "3:00 PM");
  const name = String(detail?.name ?? listing?.name ?? hotelId);
  const roomType = rate.board && !/room only/i.test(rate.board) ? `${rate.roomName} · ${rate.board}` : rate.roomName;
  try {
    const offer = OfferSchema.parse({
      offerId: `lite-${hotelId}-${shortHash(`${rate.roomName}|${rate.refundableTag}`)}`, offerVersion: "v1",
      merchantId: "liteapi", merchantName: "LiteAPI hotel inventory (sandbox)", propertyId: hotelId, propertyName: name,
      city: String(detail?.city ?? trip.destination), roomType,
      checkInAt: localToInstant(trip.checkIn, checkIn, trip.timeZone), checkOutAt: localToInstant(trip.checkOut, checkOut, trip.timeZone),
      guestCapacity: rate.maxOccupancy, stepFreeVerified: stepFree,
      cancellationPolicyCode: refundable ? "FULL_CASH_REFUND" : "NON_REFUNDABLE",
      ...(deadline && !Number.isNaN(deadline.getTime()) ? { fullRefundDeadline: deadline.toISOString() } : {}),
      subtotalCents: rate.totalCents, mandatoryFeesCents: 0, totalCents: rate.totalCents, currency: "USD", available: true,
      expiresAt: new Date(Math.min(now.getTime() + OFFER_TTL_MS, Date.parse(localToInstant(trip.checkIn, "12:00 AM", trip.timeZone)))).toISOString(),
      walkable: locationScore >= 9 || poi.filter(item => item.distanceKm <= 1).length >= 2,
      nearActivities: poi.some(item => item.distanceKm <= 2 && /major|iconic/i.test(item.importance ?? "")),
      quiet: (sentiment.pros ?? []).some((item: string) => /quiet|peaceful/i.test(item)),
      source: "LITEAPI", bookingMode: "SANDBOX",
      imageUrl: detail?.main_photo ?? listing?.main_photo, address: detail?.address ?? listing?.address,
      rating: typeof detail?.rating === "number" ? detail.rating : undefined, reviewCount: typeof detail?.reviewCount === "number" ? detail.reviewCount : undefined,
    });
    return { offer, ref: { provider: "LITEAPI", hotelId, offerId: rate.offerId, roomName: rate.roomName, refundableTag: rate.refundableTag },
      research: { sourceLabel: "LiteAPI hotel data and review analysis",
        pros: (sentiment.pros ?? []).slice(0, 3), cons: (sentiment.cons ?? []).slice(0, 3),
        nearby: [...poi].sort((a, b) => a.distanceKm - b.distanceKm).slice(0, 3).map(item => `${item.name} · ${item.distanceKm} km`) } };
  } catch { return undefined; }
}

// ---------- SerpApi Google Hotels (vacation rentals, book on the listing site) ----------

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export class GoogleHotels {
  constructor(private readonly key: string, private readonly fetcher: Fetch = fetch) {}

  async search(trip: Trip, now = new Date()): Promise<LiveStay[]> {
    const params = new URLSearchParams({ engine: "google_hotels", q: `${trip.destination} vacation rentals`, vacation_rentals: "true",
      check_in_date: trip.checkIn, check_out_date: trip.checkOut, adults: String(trip.guests), currency: "USD", gl: trip.countryCode.toLowerCase(), hl: "en", api_key: this.key });
    const body = await getJson(this.fetcher, `https://serpapi.com/search.json?${params}`, {}, 30_000);
    return (body.properties ?? []).slice(0, 20).map((property: any) => mapGoogle(trip, property, now)).filter(Boolean) as LiveStay[];
  }
}

function freeCancellationDeadline(trip: Trip, price: any) {
  const match = /^([A-Za-z]{3})\w*\s+(\d{1,2})$/.exec(String(price?.free_cancellation_until_date ?? "").trim());
  if (!price?.free_cancellation || !match) return undefined;
  const month = MONTHS.indexOf(match[1]!.toLowerCase());
  if (month < 0) return undefined;
  const checkInYear = Number(trip.checkIn.slice(0, 4)), checkInMonth = Number(trip.checkIn.slice(5, 7)) - 1;
  const year = month > checkInMonth ? checkInYear - 1 : checkInYear;
  const date = `${year}-${String(month + 1).padStart(2, "0")}-${match[2]!.padStart(2, "0")}`;
  try { return localToInstant(date, String(price.free_cancellation_until_time ?? "11:59 PM"), trip.timeZone); } catch { return undefined; }
}

function mapGoogle(trip: Trip, property: any, now: Date): LiveStay | undefined {
  if (property?.type !== "vacation rental" || !property?.property_token) return undefined;
  const total = Number(property.total_rate?.extracted_lowest);
  const sleeps = Number(/Sleeps (\d+)/i.exec((property.essential_info ?? []).join(", "))?.[1] ?? 0);
  if (!Number.isFinite(total) || total <= 0 || sleeps < trip.guests) return undefined;
  const price = (property.prices ?? [])[0];
  const cancelBy = freeCancellationDeadline(trip, price);
  const deadline = cancelBy && Date.parse(cancelBy) > now.getTime() ? cancelBy : undefined;
  const amenities: string[] = property.amenities ?? [], excluded: string[] = property.excluded_amenities ?? [];
  const stepFree = amenities.some(item => /wheelchair accessible/i.test(item)) ? true : excluded.some(item => /wheelchair accessible/i.test(item)) ? false : null;
  const nearby: Array<{ name: string; transportations?: Array<{ type: string; duration: string }> }> = property.nearby_places ?? [];
  const walkMinutes = (place: typeof nearby[number]) => Number(/(\d+)\s*min/.exec(place.transportations?.find(item => item.type === "Walking")?.duration ?? "")?.[1] ?? Infinity);
  const walkable = nearby.filter(place => walkMinutes(place) <= 15);
  const essential = (property.essential_info ?? []) as string[];
  try {
    const offer = OfferSchema.parse({
      offerId: `gh-${shortHash(property.property_token)}`, offerVersion: "v1",
      merchantId: "google-hotels", merchantName: price?.source ? String(price.source) : "Google Hotels listing",
      propertyId: shortHash(property.property_token), propertyName: String(property.name).slice(0, 160), city: trip.destination,
      roomType: essential.filter(item => !/^Sleeps/i.test(item)).slice(0, 3).join(" · ") || "Vacation rental",
      checkInAt: localToInstant(trip.checkIn, String(property.check_in_time || "4:00 PM"), trip.timeZone),
      checkOutAt: localToInstant(trip.checkOut, String(property.check_out_time || "11:00 AM"), trip.timeZone),
      guestCapacity: sleeps, stepFreeVerified: stepFree,
      cancellationPolicyCode: deadline ? "FULL_CASH_REFUND" : "NON_REFUNDABLE", ...(deadline ? { fullRefundDeadline: deadline } : {}),
      subtotalCents: cents(total), mandatoryFeesCents: 0, totalCents: cents(total), currency: "USD", available: true,
      expiresAt: new Date(Math.min(now.getTime() + OFFER_TTL_MS, Date.parse(localToInstant(trip.checkIn, "12:00 AM", trip.timeZone)))).toISOString(),
      walkable: Number(property.location_rating ?? 0) >= 4.2 || walkable.length >= 2,
      nearActivities: walkable.length >= 1, quiet: false,
      source: "GOOGLE_HOTELS", bookingMode: "EXTERNAL", externalUrl: typeof property.link === "string" ? property.link : undefined,
      imageUrl: property.images?.[0]?.thumbnail, rating: typeof property.overall_rating === "number" ? Math.round(property.overall_rating * 20) / 10 : undefined,
      reviewCount: typeof property.reviews === "number" ? property.reviews : undefined,
    });
    return { offer, ref: { provider: "GOOGLE_HOTELS", propertyToken: property.property_token },
      research: { sourceLabel: `Google Hotels listing${price?.source ? ` via ${price.source}` : ""}`,
        pros: amenities.slice(0, 3), cons: excluded.slice(0, 3),
        nearby: nearby.slice(0, 3).map(place => `${place.name}${Number.isFinite(walkMinutes(place)) ? ` · ${walkMinutes(place)} min walk` : ""}`) } };
  } catch { return undefined; }
}

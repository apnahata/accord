/** Decode SSE frames across arbitrary UTF-8 chunks, including CRLF split boundaries. */
export async function* decodeSse(body, { maxFrameBytes = 65_536 } = {}) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "", event = "message", id, data = [], frameSize = 0;
  function line(value) {
    if (value === "") {
      const frame = data.length ? { event, id, data: data.join("\n") } : undefined;
      event = "message"; id = undefined; data = []; frameSize = 0;
      return frame;
    }
    frameSize += Buffer.byteLength(value);
    if (frameSize > maxFrameBytes) throw new Error("SSE_FRAME_TOO_LARGE");
    if (value.startsWith(":")) return;
    const colon = value.indexOf(":");
    const field = colon < 0 ? value : value.slice(0, colon);
    let content = colon < 0 ? "" : value.slice(colon + 1);
    if (content.startsWith(" ")) content = content.slice(1);
    if (field === "event") event = content;
    else if (field === "id" && !content.includes("\0")) id = content;
    else if (field === "data") data.push(content);
  }
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break; // An incomplete final frame is not dispatched by EventSource either.
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const end = buffer.search(/[\r\n]/);
        if (end < 0 || (buffer[end] === "\r" && end === buffer.length - 1)) break;
        const width = buffer[end] === "\r" && buffer[end + 1] === "\n" ? 2 : 1;
        const frame = line(buffer.slice(0, end));
        buffer = buffer.slice(end + width);
        if (frame) yield frame;
      }
      if (Buffer.byteLength(buffer) + frameSize > maxFrameBytes) throw new Error("SSE_FRAME_TOO_LARGE");
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function matches(frame, expected) {
  if (expected.event && frame.event !== expected.event) return false;
  if (!expected.field && !expected.where) return true;
  let value;
  try { value = JSON.parse(frame.data); } catch { return false; }
  const conditions = { ...expected.where, ...(expected.field ? { [expected.field]: expected.value } : {}) };
  for (const [field, desired] of Object.entries(conditions)) {
    let current = value;
    for (const key of field.split(".")) {
      if (current === null || typeof current !== "object" || !Object.hasOwn(current, key)) return false;
      current = current[key];
    }
    if (current !== desired) return false;
  }
  return true;
}

// A stand-in for Twilio's Messages API, used by the tests and for local development.
//   POST /2010-04-01/Accounts/<sid>/Messages.json   behaves like Twilio: checks Basic auth, records the text
//   GET  /__calls?to=+1555...                        every text "sent" to that number
//   POST /__fail  {to, status, code, times}          make the next N sends to that number fail
//   POST /__reset                                    forget everything
import http from "node:http";

const SID = process.env.TWILIO_ACCOUNT_SID ?? "ACtest";
const TOKEN = process.env.TWILIO_AUTH_TOKEN ?? "test";
const PORT = Number(process.env.FAKE_TWILIO_PORT ?? 4020);
const expectedAuth = "Basic " + Buffer.from(`${SID}:${TOKEN}`).toString("base64");

let calls = [];
const rules = new Map(); // to -> { status, code, message, times }
let counter = 0;

const readBody = (req) => new Promise((resolve) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => resolve(data));
});
const json = (res, status, body) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");

  if (req.method === "GET" && url.pathname === "/__health") return json(res, 200, { ok: true });
  if (req.method === "GET" && url.pathname === "/__calls") {
    const to = url.searchParams.get("to");
    return json(res, 200, to ? calls.filter((c) => c.to === to) : calls);
  }
  if (req.method === "POST" && url.pathname === "/__reset") {
    calls = [];
    rules.clear();
    return json(res, 200, { ok: true });
  }
  if (req.method === "POST" && url.pathname === "/__fail") {
    const r = JSON.parse(await readBody(req));
    rules.set(r.to, { status: r.status ?? 500, code: r.code ?? null, message: r.message ?? "forced failure", times: r.times ?? 1 });
    return json(res, 200, { ok: true });
  }

  if (req.method === "POST" && url.pathname === `/2010-04-01/Accounts/${SID}/Messages.json`) {
    if (req.headers.authorization !== expectedAuth) return json(res, 401, { code: 20003, message: "Authenticate", status: 401 });
    const form = new URLSearchParams(await readBody(req));
    const to = form.get("To");
    const rule = rules.get(to);
    if (rule && rule.times > 0) {
      rule.times -= 1;
      calls.push({ to, body: form.get("Body"), outcome: `failed:${rule.status}`, at: Date.now() });
      return json(res, rule.status, { code: rule.code, message: rule.message, status: rule.status });
    }
    counter += 1;
    const sid = "SM" + counter.toString(16).padStart(32, "0");
    calls.push({ sid, to, from: form.get("From"), body: form.get("Body"), statusCallback: form.get("StatusCallback"), outcome: "sent", at: Date.now() });
    return json(res, 201, { sid, status: "queued", to, from: form.get("From"), body: form.get("Body") });
  }

  json(res, 404, { message: "not found" });
}).listen(PORT, () => console.log(`fake twilio listening on ${PORT}`));

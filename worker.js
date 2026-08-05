const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...corsHeaders,
    },
  });
}

function clean(value) {
  return String(value ?? "").trim();
}

function safeKey(value) {
  return clean(value)
    .replaceAll("\\", "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/[^a-zA-Z0-9._/-]/g, "_");
}

function pharmacyPrefix(licenseKey) {
  return `pharmacy/${safeKey(licenseKey)}/`;
}

async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

function requireStorage(env) {
  if (!env.RXGUARD_DATA) {
    throw new Error("RXGUARD_DATA KV bağlantısı kurulmamış.");
  }
}

async function validateLicense(licenseKey, deviceCode, deviceName) {
  licenseKey = clean(licenseKey);
  deviceCode = clean(deviceCode);
  deviceName = clean(deviceName);

  if (!licenseKey || !deviceCode) {
    return json({ ok: false, valid: false, message: "licenseKey ve deviceCode gerekli." }, 400);
  }

  const accepted = licenseKey === "RXG-DEMO-2026-0001" || licenseKey.startsWith("RXG-");

  return json({
    ok: accepted,
    valid: accepted,
    licenseKey,
    deviceCode,
    deviceName,
    pharmacyId: licenseKey,
    plan: accepted ? "demo" : null,
    message: accepted ? "RxGuard bulut lisansı doğrulandı." : "Lisans geçersiz.",
  }, accepted ? 200 : 403);
}

async function cloudGet(request, env) {
  requireStorage(env);
  const body = await readJson(request);
  const licenseKey = clean(body.licenseKey);
  const deviceCode = clean(body.deviceCode);
  const key = safeKey(body.key);

  if (!licenseKey || !deviceCode || !key) {
    return json({ ok: false, found: false, message: "licenseKey, deviceCode ve key gerekli." }, 400);
  }

  const storageKey = `${pharmacyPrefix(licenseKey)}data/${key}`;
  const record = await env.RXGUARD_DATA.get(storageKey, "json");

  if (!record) {
    return json({ ok: true, found: false, key, revision: 0, message: "Bulut kaydı bulunamadı." });
  }

  return json({ ok: true, found: true, ...record });
}

async function cloudPut(request, env) {
  requireStorage(env);
  const body = await readJson(request);
  const licenseKey = clean(body.licenseKey);
  const deviceCode = clean(body.deviceCode);
  const deviceName = clean(body.deviceName);
  const key = safeKey(body.key);
  const payloadBase64 = clean(body.payloadBase64);
  const sha256 = clean(body.sha256);

  if (!licenseKey || !deviceCode || !key || !payloadBase64) {
    return json({
      ok: false,
      message: "licenseKey, deviceCode, key ve payloadBase64 gerekli.",
    }, 400);
  }

  const storageKey = `${pharmacyPrefix(licenseKey)}data/${key}`;
  const previous = await env.RXGUARD_DATA.get(storageKey, "json");
  const revision = Number(previous?.revision ?? 0) + 1;

  const record = {
    key,
    payloadBase64,
    sha256,
    revision,
    deviceCode,
    deviceName,
    updatedAt: new Date().toISOString(),
  };

  await env.RXGUARD_DATA.put(storageKey, JSON.stringify(record));

  return json({
    ok: true,
    saved: true,
    key,
    revision,
    sha256,
    updatedAt: record.updatedAt,
    message: "Bulut kaydı oluşturuldu.",
  });
}

async function cloudList(request, env) {
  requireStorage(env);
  const body = await readJson(request);
  const licenseKey = clean(body.licenseKey);
  const deviceCode = clean(body.deviceCode);
  const requestedPrefix = safeKey(body.prefix || "");

  if (!licenseKey || !deviceCode) {
    return json({ ok: false, message: "licenseKey ve deviceCode gerekli." }, 400);
  }

  const basePrefix = `${pharmacyPrefix(licenseKey)}data/`;
  const listed = await env.RXGUARD_DATA.list({
    prefix: `${basePrefix}${requestedPrefix}`,
    limit: 1000,
  });

  const records = [];
  for (const item of listed.keys) {
    const record = await env.RXGUARD_DATA.get(item.name, "json");
    if (record) records.push(record);
  }

  records.sort((a, b) =>
    String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? ""))
  );

  return json({
    ok: true,
    count: records.length,
    records,
    items: records,
  });
}

export default {
  async fetch(request, env) {
    try {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders });
      }

      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";

      if (
        request.method === "GET" &&
        (path === "/" || path === "/health" || path === "/api/health")
      ) {
        return json({
          ok: true,
          service: "RxGuard Cloud API",
          version: "1.0.0",
          storageReady: Boolean(env.RXGUARD_DATA),
          time: new Date().toISOString(),
        });
      }

      const licenseMatch = path.match(
        /^\/api\/desktop\/license\/validate-get\/([^/]+)\/([^/]+)\/([^/]+)$/
      );

      if (request.method === "GET" && licenseMatch) {
        return validateLicense(
          decodeURIComponent(licenseMatch[1]),
          decodeURIComponent(licenseMatch[2]),
          decodeURIComponent(licenseMatch[3])
        );
      }

      if (request.method === "POST" && path === "/api/desktop/cloud/get") {
        return cloudGet(request, env);
      }

      if (request.method === "POST" && path === "/api/desktop/cloud/put") {
        return cloudPut(request, env);
      }

      if (request.method === "POST" && path === "/api/desktop/cloud/list") {
        return cloudList(request, env);
      }

      return json({
        ok: false,
        message: "Endpoint bulunamadı.",
        method: request.method,
        path,
      }, 404);
    } catch (error) {
      return json({
        ok: false,
        message: error?.message || "Sunucu hatası.",
      }, 500);
    }
  },
};

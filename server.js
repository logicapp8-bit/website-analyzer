const fs = require("fs");
const path = require("path");

// Load .env only if it exists (local dev). On Railway, env vars are set directly.
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, "utf8").split("\n").forEach(line => {
    const eq = line.indexOf("=");
    if (eq > 0) {
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim();
      if (k) process.env[k] = v;
    }
  });
}

const express = require("express");
const Groq = require("groq-sdk");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.post("/analyze", async (req, res) => {
  const { url } = req.body;

  if (!url || !url.startsWith("http")) {
    return res.status(400).json({ error: "Valid URL required (must start with http/https)" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    res.write(`data: ${JSON.stringify({ error: "GROQ_API_KEY not set in .env file" })}\n\n`);
    return res.end();
  }

  try {
    const reqHeaders = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
      "Cache-Control": "no-cache",
    };

    let fetchResponse = await fetch(url, { headers: reqHeaders, signal: AbortSignal.timeout(20000) });

    // If blocked, try HEAD request to get at least headers
    let html = "";
    let blockedNote = "";
    if (!fetchResponse.ok) {
      const headResponse = await fetch(url, { method: "HEAD", headers: reqHeaders, signal: AbortSignal.timeout(10000) }).catch(() => null);
      if (headResponse) {
        fetchResponse = headResponse;
        blockedNote = `Note: Website returned ${fetchResponse.status} (access restricted). Analysis based on HTTP headers only.`;
      } else {
        res.write(`data: ${JSON.stringify({ error: `Could not access website (${fetchResponse.status}). The site may be blocking automated requests.` })}\n\n`);
        return res.end();
      }
    } else {
      html = await fetchResponse.text();
    }

    // Take start + end of HTML — script tags are usually at bottom
    const truncatedHtml = html.length > 5000
      ? html.slice(0, 2500) + "\n...\n" + html.slice(-2500)
      : html;
    const allHeaders = Object.fromEntries(fetchResponse.headers.entries());
    const headers = Object.fromEntries(
      Object.entries(allHeaders).filter(([k]) =>
        ["server","x-powered-by","set-cookie","content-type","via","x-generator",
         "cache-control","strict-transport-security","x-framework","x-drupal-cache",
         "x-wordpress","cf-cache-status","x-vercel","x-amz","x-cache"].some(h => k.toLowerCase().includes(h))
      )
    );

    // Try fetching common backend config files in parallel
    const configPaths = [
      "/package.json",           // Node.js — mongoose=MongoDB, pg=PostgreSQL, mysql2=MySQL, mssql=SQLServer
      "/package-lock.json",      // More dependency details
      "/composer.json",          // PHP — doctrine=SQL, mongodb=MongoDB, laravel=MySQL
      "/requirements.txt",       // Python — psycopg2=PostgreSQL, pymongo=MongoDB, mysqlclient=MySQL
      "/Pipfile",                // Python Pipfile
      "/Gemfile",                // Ruby — pg=PostgreSQL, mysql2=MySQL, mongoid=MongoDB, sqlite3=SQLite
      "/Procfile",               // Heroku — DB URL hints
      "/robots.txt",             // CMS hints
      "/wp-login.php",           // WordPress = MySQL
      "/config/database.yml",    // Rails DB config — adapter: postgresql/mysql/sqlite3
      "/config/database.json",   // Generic DB config
      "/.env.example",           // DB_CONNECTION, DATABASE_URL hints
      "/app/etc/env.php",        // Magento = MySQL
      "/pom.xml",                // Java — hibernate dialect hints
      "/build.gradle",           // Java/Kotlin — DB dependencies
      "/go.mod",                 // Go — database driver hints
      "/pyproject.toml",         // Python modern config
    ];
    const baseUrl = new URL(url).origin;
    const configResults = await Promise.allSettled(
      configPaths.map(p =>
        fetch(baseUrl + p, {
          headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
        "Cache-Control": "no-cache",
      },
          signal: AbortSignal.timeout(4000),
        }).then(r => r.ok ? r.text().then(t => ({ path: p, content: t.slice(0, 800) })) : null)
        .catch(() => null)
      )
    );
    const configFiles = configResults
      .filter(r => r.status === "fulfilled" && r.value)
      .map(r => `--- ${r.value.path} ---\n${r.value.content.slice(0, 300)}`)
      .join("\n\n");

    console.log("Config files found:", configResults.filter(r => r.status === "fulfilled" && r.value).map(r => r.value.path));

    const prompt = `You are an expert website technology detector. Look for SPECIFIC technology names — not generic ones like "HTML" or "CSS" or "JavaScript". Find the actual frameworks, libraries and tools.

URL: ${url}
${blockedNote ? blockedNote + "\n" : ""}HTTP Headers: ${JSON.stringify(headers)}
HTML Source: ${truncatedHtml}
${configFiles ? `Config Files:\n${configFiles}` : ""}

Detect SPECIFIC technologies (e.g. React not "JavaScript", Tailwind not "CSS", Next.js not "framework").
Write each as: **TechName** — one-line evidence

## 🎨 Frontend Technologies
Look for: script src names (react, vue, angular, svelte, jquery), CSS class patterns (tw- = Tailwind, bootstrap classes), link tags, meta generators, bundler hints (webpack chunks, vite, parcel), font/icon libraries.

## 🏗️ Frontend Architecture
Rendering: SSR (Next.js/Nuxt), CSR (React/Vue SPA), SSG (Gatsby/Hugo). State management, lazy loading, PWA manifest.

## ⚙️ Backend & Server
From headers: Server (nginx/apache/IIS), X-Powered-By (PHP/Express/ASP.NET). CDN hints, response headers framework clues.

## 🗄️ Database
From config files: mongoose→MongoDB, pg→PostgreSQL, mysql2→MySQL. Stack inference: ASP.NET→SQL Server, WordPress→MySQL, Laravel→MySQL, Django→PostgreSQL, Rails→PostgreSQL. Write **Unknown** if no evidence.

## 🔧 Security
HTTPS, HSTS, CSP header, X-Frame-Options, cookie flags.

## 🌐 Infrastructure
CDN (Cloudflare/Fastly/Akamai), cloud (AWS/GCP/Azure/Vercel/Netlify), analytics scripts (gtag=Google Analytics, fbq=Facebook Pixel, hotjar, mixpanel).`;

    const groq = new Groq({ apiKey });
    const stream = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 1200,
      stream: true,
    });

    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content || "";
      if (text) {
        res.write(`data: ${JSON.stringify({ text })}\n\n`);
      }
    }

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    let msg = err.message;
    if (err.name === "TimeoutError") msg = "Website took too long to respond. Please try again.";
    else if (msg === "fetch failed" || msg.includes("ECONNREFUSED") || msg.includes("ENOTFOUND"))
      msg = "Cannot reach this website from our server. It may be blocking cloud/datacenter requests (common with Flipkart, Amazon, banking sites). Try a different URL.";
    res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
    res.end();
  }
});

app.post("/diagram", async (req, res) => {
  const { analysisText } = req.body;
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey || !analysisText) return res.status(400).json({ error: "Missing data" });

  try {
    const groq = new Groq({ apiKey });
    const completion = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [{
        role: "user",
        content: `Based on this website technology analysis, extract the detected technologies into a JSON object.

Analysis:
${analysisText.slice(0, 3000)}

Return ONLY a valid JSON object in this exact format (no other text, no markdown):
{"frontend":[],"backend":[],"database":[],"infrastructure":[],"analytics":[]}

Rules:
- frontend: JS frameworks, CSS frameworks, UI libraries, build tools
- backend: server software, backend language/framework
- database: detect from analysis text. If "Unknown" in analysis, use stack inference:
  ASP.NET/IIS = "SQL Server", Laravel/PHP = "MySQL", Django/Python = "PostgreSQL",
  Rails/Ruby = "PostgreSQL", WordPress = "MySQL", Firebase = "Firestore",
  Supabase = "PostgreSQL", Plesk+PHP = "MySQL". Use "Unknown" only if no stack clue.
- infrastructure: cloud provider, CDN, hosting
- analytics: analytics/tracking tools
- Max 5 items per array, short names only (e.g. "React" not "React.js library")
- Return only the JSON, nothing else`
      }],
      max_tokens: 300,
    });

    const text = completion.choices[0]?.message?.content?.trim() || "{}";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const data = jsonMatch ? JSON.parse(jsonMatch[0]) : {};

    const be  = (data.backend       || []).join(" ").toLowerCase();
    const fe  = (data.frontend      || []).join(" ").toLowerCase();
    const inf = (data.infrastructure|| []).join(" ").toLowerCase();
    const txt = (analysisText       || "").toLowerCase();

    // ── Database inference ──────────────────────────────────────
    const db = (data.database || []).join(" ").toLowerCase();
    if (!db || db.includes("unknown")) {
      let inferred = null;
      if (be.includes("asp.net") || be.includes("iis") || txt.includes("asp.net")) inferred = "SQL Server";
      else if (be.includes("laravel") || txt.includes("laravel"))                  inferred = "MySQL";
      else if (be.includes("wordpress") || txt.includes("wordpress"))              inferred = "MySQL";
      else if (be.includes("django")  || txt.includes("django"))                   inferred = "PostgreSQL";
      else if (be.includes("rails")   || be.includes("ruby"))                      inferred = "PostgreSQL";
      else if (be.includes("spring")  || be.includes("java"))                      inferred = "MySQL / PostgreSQL";
      else if (fe.includes("firebase")|| txt.includes("firebase"))                 inferred = "Firestore";
      else if (txt.includes("supabase"))                                            inferred = "PostgreSQL";
      else if (be.includes("php")     || txt.includes("phpsessid"))                inferred = "MySQL";
      else if (inf.includes("plesk"))                                               inferred = "MySQL";
      if (inferred) data.database = [`${inferred} (inferred)`];
    }

    // ── Infrastructure / CDN inference ──────────────────────────
    const infraItems = new Set((data.infrastructure || []).filter(i => i && !i.toLowerCase().includes("unknown")));
    if (txt.includes("cloudflare") || txt.includes("cf-ray") || txt.includes("cf-cache")) infraItems.add("Cloudflare");
    if (txt.includes("vercel")  || txt.includes("x-vercel"))     infraItems.add("Vercel");
    if (txt.includes("netlify"))                                  infraItems.add("Netlify");
    if (txt.includes("fastly"))                                   infraItems.add("Fastly CDN");
    if (txt.includes("akamai"))                                   infraItems.add("Akamai CDN");
    if (txt.includes("amazonaws") || txt.includes("aws") || txt.includes("cloudfront")) infraItems.add("AWS");
    if (txt.includes("azure"))                                    infraItems.add("Azure");
    if (txt.includes("googleapis") || txt.includes("gcp"))       infraItems.add("Google Cloud");
    if (txt.includes("heroku"))                                   infraItems.add("Heroku");
    if (txt.includes("railway"))                                  infraItems.add("Railway");
    if (txt.includes("digitalocean"))                             infraItems.add("DigitalOcean");
    if (txt.includes("plesk"))                                    infraItems.add("Plesk Hosting");
    if (infraItems.size > 0) data.infrastructure = [...infraItems].slice(0, 5);

    // ── Analytics inference ──────────────────────────────────────
    const analyticsItems = new Set((data.analytics || []).filter(a => a && !a.toLowerCase().includes("unknown")));
    if (txt.includes("google-analytics") || txt.includes("gtag") || txt.includes("ga.js") || txt.includes("analytics.js") || txt.includes("googletagmanager")) analyticsItems.add("Google Analytics");
    if (txt.includes("facebook") && (txt.includes("pixel") || txt.includes("fbq")))  analyticsItems.add("Facebook Pixel");
    if (txt.includes("hotjar"))                                   analyticsItems.add("Hotjar");
    if (txt.includes("mixpanel"))                                 analyticsItems.add("Mixpanel");
    if (txt.includes("segment"))                                  analyticsItems.add("Segment");
    if (txt.includes("plausible"))                                analyticsItems.add("Plausible");
    if (txt.includes("fullstory"))                                analyticsItems.add("FullStory");
    if (txt.includes("intercom"))                                 analyticsItems.add("Intercom");
    if (txt.includes("hubspot"))                                  analyticsItems.add("HubSpot");
    if (txt.includes("crisp"))                                    analyticsItems.add("Crisp Chat");
    if (txt.includes("clarity") && txt.includes("microsoft"))    analyticsItems.add("Microsoft Clarity");
    if (txt.includes("amplitude"))                                analyticsItems.add("Amplitude");
    if (txt.includes("heap"))                                     analyticsItems.add("Heap");
    if (txt.includes("datadog"))                                  analyticsItems.add("Datadog");
    if (txt.includes("sentry"))                                   analyticsItems.add("Sentry");
    if (analyticsItems.size > 0) data.analytics = [...analyticsItems].slice(0, 5);

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/flow", async (req, res) => {
  const { analysisText, url } = req.body;
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey || !analysisText) return res.status(400).json({ error: "Missing data" });

  try {
    const groq = new Groq({ apiKey });
    const completion = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [{
        role: "user",
        content: `Based on this website technology analysis for ${url}, generate the website request flow and user journey.

Analysis:
${analysisText.slice(0, 3000)}

Return ONLY a valid JSON object (no markdown, no extra text):
{
  "requestFlow": [
    {"step": 1, "node": "User Browser", "icon": "🌐", "detail": "one line"},
    {"step": 2, "node": "CDN", "icon": "⚡", "detail": "one line"},
    {"step": 3, "node": "Web Server", "icon": "🖥️", "detail": "one line"},
    {"step": 4, "node": "Backend", "icon": "⚙️", "detail": "one line"},
    {"step": 5, "node": "Database", "icon": "🗄️", "detail": "one line"},
    {"step": 6, "node": "Response", "icon": "📦", "detail": "one line"}
  ],
  "userJourney": [
    {"step": 1, "action": "Land on Homepage", "icon": "🏠", "detail": "one line"},
    {"step": 2, "action": "Browse/Search", "icon": "🔍", "detail": "one line"},
    {"step": 3, "action": "Login/Signup", "icon": "🔐", "detail": "one line"},
    {"step": 4, "action": "Core Action", "icon": "⚡", "detail": "one line"},
    {"step": 5, "action": "API Call", "icon": "📡", "detail": "one line"}
  ]
}

Rules:
- requestFlow: show actual request path based on detected CDN, server, backend, database
- Skip nodes that are not applicable (e.g. no CDN detected, remove it)
- userJourney: based on what the website does (e.g. GitHub = code repo, Netflix = streaming)
- Keep "node" and "action" short (2-3 words max)
- "detail" = one short line of what happens at that step
- Return only JSON, nothing else`
      }],
      max_tokens: 600,
    });

    const text = completion.choices[0]?.message?.content?.trim() || "{}";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    const data = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/scorecard", async (req, res) => {
  const { analysisText } = req.body;
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey || !analysisText) return res.status(400).json({ error: "Missing data" });

  try {
    const groq = new Groq({ apiKey });
    const completion = await groq.chat.completions.create({
      model: "llama-3.1-8b-instant",
      messages: [{
        role: "user",
        content: `Score this website's tech stack 0-10 in 4 categories.

Analysis: ${analysisText.slice(0, 1500)}

Return ONLY valid JSON, no markdown:
{"performance":{"score":7,"reason":"short reason"},"security":{"score":5,"reason":"short reason"},"modernity":{"score":8,"reason":"short reason"},"scalability":{"score":6,"reason":"short reason"}}

- performance: CDN, caching, minification, HTTP/2
- security: HTTPS, HSTS, CSP, X-Frame-Options
- modernity: modern vs legacy tech (jQuery/PHP=low, Next.js/Go=high)
- scalability: cloud hosting, load balancing, microservices
- reason: max 6 words each
Return only JSON.`
      }],
      max_tokens: 220,
    });

    const text = completion.choices[0]?.message?.content?.trim() || "{}";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    let data = {};
    try { data = jsonMatch ? JSON.parse(jsonMatch[0]) : {}; } catch(e) { data = {}; }

    // Normalize: handle flat {performance:8} or nested {performance:{score:8}}
    ["performance","security","modernity","scalability"].forEach(k => {
      if (typeof data[k] === "number") data[k] = { score: data[k], reason: "" };
      if (!data[k] || typeof data[k] !== "object") data[k] = { score: 5, reason: "" };
    });

    const scores = ["performance","security","modernity","scalability"].map(k => Number(data[k].score) || 5);
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    data.grade = avg >= 9 ? "A+" : avg >= 8 ? "A" : avg >= 7 ? "B+" : avg >= 6 ? "B" : avg >= 5 ? "C+" : avg >= 4 ? "C" : "D";
    data.avg = Math.round(avg * 10) / 10;

    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3500;
app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
  console.log(`🔑 Groq API Key: ${process.env.GROQ_API_KEY ? "Set ✓" : "NOT SET ✗"}`);
});

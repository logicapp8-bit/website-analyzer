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
    const fetchResponse = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; WebAnalyzer/1.0)" },
      signal: AbortSignal.timeout(20000),
    });

    if (!fetchResponse.ok) {
      res.write(`data: ${JSON.stringify({ error: `Website fetch failed: ${fetchResponse.status}` })}\n\n`);
      return res.end();
    }

    const html = await fetchResponse.text();
    const truncatedHtml = html.slice(0, 2000);
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
          headers: { "User-Agent": "Mozilla/5.0 (compatible; WebAnalyzer/1.0)" },
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

    const prompt = `You are a website tech stack detector. Analyze the data below and write each detected technology in bold followed by a one-line reason.

URL: ${url}
Headers: ${JSON.stringify(headers)}
HTML: ${truncatedHtml}
${configFiles ? `Config files:\n${configFiles}` : ""}

Respond with these sections:

## 🎨 Frontend
**TechName** — reason

## 🏗️ Architecture
**TechName** — reason

## ⚙️ Backend & Server
**TechName** — reason

## 🗄️ Database
**TechName** — reason
(Rules: mongoose=MongoDB, pg=PostgreSQL, mysql2=MySQL, ASP.NET/IIS=SQL Server, WordPress=MySQL, Laravel=MySQL, Django=PostgreSQL, Rails=PostgreSQL, Firebase=Firestore. If no evidence write **Unknown**.)

## 🔧 Security
**TechName** — reason

## 🌐 Infrastructure
**TechName** — reason`;

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
    const msg = err.name === "TimeoutError"
      ? "Website took too long to respond. Please try again or try a different URL."
      : err.message;
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

const PORT = process.env.PORT || 3500;
app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
  console.log(`🔑 Groq API Key: ${process.env.GROQ_API_KEY ? "Set ✓" : "NOT SET ✗"}`);
});

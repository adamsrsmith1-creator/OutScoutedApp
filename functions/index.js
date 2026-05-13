const functions = require("firebase-functions");
const admin = require("firebase-admin");
const cors = require("cors")({origin: true});

admin.initializeApp();

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const ADMIN_EMAIL = "adamsrsmith1@gmail.com";
const db = admin.firestore();

/**
 * Verify Firebase Auth token and check admin email.
 */
async function verifyAdmin(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new Error("Unauthorized");
  }
  const idToken = authHeader.split("Bearer ")[1];
  const decodedToken = await admin.auth().verifyIdToken(idToken);
  if (decodedToken.email !== ADMIN_EMAIL) {
    throw new Error("Admin access required");
  }
  return decodedToken;
}

/**
 * Launch a Puppeteer browser instance using serverless Chromium.
 */
async function launchBrowser() {
  const chromium = require("@sparticuz/chromium");
  const puppeteer = require("puppeteer-core");
  return puppeteer.launch({
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
  });
}

/**
 * gcLogin – Firebase Cloud Function
 *
 * Handles GameChanger login with 2FA code support.
 * Flow:
 *   1. Client calls with {action: "start"} → function begins login,
 *      writes status to Firestore, polls for verification code
 *   2. Client enters code → writes to Firestore gc_config/login_session
 *   3. Function picks up code, completes login, saves cookies
 *
 * Or for direct login with code:
 *   Client calls with {action: "submit_code", code: "123456"} and the
 *   function does the full login in one shot.
 */
exports.gcLogin = functions
    .runWith({
      timeoutSeconds: 540,
      memory: "2GB",
    })
    .https.onRequest((req, res) => {
      cors(req, res, async () => {
        if (req.method !== "POST") {
          res.status(405).json({error: "POST required"});
          return;
        }

        try {
          await verifyAdmin(req);
        } catch (authErr) {
          res.status(401).json({error: authErr.message});
          return;
        }

        const {action} = req.body;

        if (action === "status") {
          // Return current login session status
          const doc = await db.doc("gc_config/login_session").get();
          res.json(doc.exists ? doc.data() : {status: "none"});
          return;
        }

        if (action === "submit_code") {
          // User is submitting the verification code
          const {code} = req.body;
          if (!code) {
            res.status(400).json({error: "Code is required"});
            return;
          }
          await db.doc("gc_config/login_session").set(
              {code, status: "code_submitted"},
              {merge: true},
          );
          res.json({status: "code_submitted"});
          return;
        }

        if (action !== "start") {
          res.status(400).json({
            error: "Invalid action. Use 'start', 'submit_code', or 'status'",
          });
          return;
        }

        // action === "start" — begin the login flow
        const gcEmail = process.env.GC_EMAIL;
        const gcPassword = process.env.GC_PASSWORD;
        if (!gcEmail || !gcPassword) {
          res.status(500).json({
            error: "GC credentials not configured on server",
          });
          return;
        }

        // Clear any previous session
        await db.doc("gc_config/login_session").set({
          status: "starting",
          startedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        let browser;
        try {
          browser = await launchBrowser();
          const page = await browser.newPage();
          await page.setUserAgent(
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
              "AppleWebKit/537.36 (KHTML, like Gecko) " +
              "Chrome/120.0.0.0 Safari/537.36",
          );

          // Step 1: Navigate to login page
          console.log("gcLogin: navigating to login page");
          await page.goto("https://web.gc.com/login", {
            waitUntil: "networkidle2",
            timeout: 30000,
          });
          await delay(2000);

          // Step 2: Enter email
          console.log("gcLogin: entering email");
          await page.waitForSelector("input[name=\"email\"]", {timeout: 10000});
          await page.type("input[name=\"email\"]", gcEmail, {delay: 50});
          await delay(500);

          // Click Continue button (original approach that works)
          console.log("gcLogin: clicking Continue");
          const continueBtn = await page.$("button[type=\"button\"]");
          if (continueBtn) {
            await continueBtn.click();
          } else {
            await page.keyboard.press("Enter");
          }
          // Wait for the password page to load
          console.log("gcLogin: waiting for password page");
          await page.waitForSelector(
              "input[name=\"password\"]", {timeout: 15000},
          );
          await delay(2000);

          // Step 3: Check if code field exists (2FA required)
          const hasCodeField = await page.$("input[name=\"code\"]");

          if (hasCodeField) {
            // 2FA code required — signal the client and poll for code
            console.log("gcLogin: 2FA code required, waiting for user");
            await db.doc("gc_config/login_session").set({
              status: "code_required",
              startedAt: admin.firestore.FieldValue.serverTimestamp(),
            });

            // Poll Firestore for the code (up to 5 minutes)
            let code = null;
            const maxWait = 300; // 5 minutes
            const pollInterval = 3; // 3 seconds
            for (let i = 0; i < maxWait / pollInterval; i++) {
              await delay(pollInterval * 1000);
              const sessionDoc = await db.doc(
                  "gc_config/login_session",
              ).get();
              if (sessionDoc.exists &&
                  sessionDoc.data().status === "code_submitted" &&
                  sessionDoc.data().code) {
                code = sessionDoc.data().code;
                break;
              }
            }

            if (!code) {
              await db.doc("gc_config/login_session").set({
                status: "timeout",
              });
              res.json({status: "timeout", message: "Code entry timed out"});
              return;
            }

            // Enter code — simple click + type (matches working Playwright test)
            console.log("gcLogin: entering verification code:", code);
            const codeField = await page.$("input[name=\"code\"]");
            await codeField.click({clickCount: 3}); // select any existing text
            await codeField.type(code, {delay: 80});
            await delay(300);

            // Log what the code field contains
            const codeVal = await page.$eval(
                "input[name=\"code\"]", (el) => el.value,
            );
            console.log("gcLogin: code field value after typing:", codeVal);
          }

          // Enter password — simple click + type
          console.log("gcLogin: entering password");
          const pwField = await page.$("input[name=\"password\"]");
          await pwField.click({clickCount: 3}); // select any existing text
          await pwField.type(gcPassword, {delay: 50});
          await delay(300);

          // Log page state before clicking Sign In
          const pageText = await page.evaluate(() => {
            return document.querySelector("main").innerText.substring(0, 500);
          });
          console.log("gcLogin: page text before submit:", pageText);

          // Click Sign in button directly
          console.log("gcLogin: clicking Sign in");
          const signInBtn = await page.$("button[type=\"submit\"]");
          if (signInBtn) {
            await signInBtn.click();
          } else {
            console.log("gcLogin: no submit button found, pressing Enter");
            await page.keyboard.press("Enter");
          }
          await delay(5000);

          // Check if login succeeded by looking at the URL
          const currentUrl = await page.url();
          console.log("gcLogin: post-login URL:", currentUrl);

          if (currentUrl.includes("/login")) {
            // Still on login page — capture full error details
            const errorText = await page.evaluate(() => {
              const el = document.querySelector("main");
              return el ? el.innerText : "";
            });
            console.log("gcLogin: FAILED - still on login page. Page text:",
                errorText.substring(0, 500));
            const errorMsg = errorText.includes("new verification code") ?
                "Code expired or invalid — GC sent a new code" :
                errorText.includes("incorrect") ?
                    "Email or password incorrect" :
                    "Login failed: " + errorText.substring(0, 200);
            await db.doc("gc_config/login_session").set({
              status: "failed",
              error: errorMsg,
            });
            res.json({status: "failed", message: errorMsg});
            return;
          }

          // Login succeeded — save cookies
          console.log("gcLogin: login succeeded, saving cookies");
          const cookies = await page.cookies();
          await db.doc("gc_config/cookies").set({
            cookies: JSON.stringify(cookies),
            savedAt: admin.firestore.FieldValue.serverTimestamp(),
            email: gcEmail,
          });
          await db.doc("gc_config/login_session").set({
            status: "success",
          });

          res.json({
            status: "success",
            message: "Logged in and cookies saved",
            cookieCount: cookies.length,
          });
        } catch (err) {
          console.error("gcLogin error:", err.message, err.stack);
          await db.doc("gc_config/login_session").set({
            status: "error",
            error: err.message,
          });
          res.status(500).json({error: err.message});
        } finally {
          if (browser) await browser.close();
        }
      });
    });

/**
 * scrapeGameChanger – Firebase Cloud Function
 *
 * Accepts a GameChanger team URL, scrapes the schedule page to find all games,
 * then scrapes each game's box score and play-by-play data.
 * Loads saved GC cookies from Firestore to access authenticated data.
 *
 * Returns structured JSON with team info, game list, and per-game data.
 */
exports.scrapeGameChanger = functions
    .runWith({
      timeoutSeconds: 540, // 9 min max
      memory: "2GB",
    })
    .https.onRequest((req, res) => {
      cors(req, res, async () => {
        if (req.method !== "POST") {
          res.status(405).json({error: "POST required"});
          return;
        }

        try {
          await verifyAdmin(req);
        } catch (authErr) {
          res.status(401).json({error: authErr.message});
          return;
        }

        const {teamUrl, maxGames} = req.body;
        if (!teamUrl || !(teamUrl.startsWith("https://web.gc.com/teams/") || teamUrl.startsWith("https://www.gc.com/teams/"))) {
          res.status(400).json({
            error: "Invalid URL. Provide a GameChanger team URL " +
              "(e.g. https://web.gc.com/teams/XXXXX)",
          });
          return;
        }

        // Load saved GC cookies and localStorage auth tokens
        let gcCookies = null;
        let gcLocalStorage = null;
        try {
          const cookieDoc = await db.doc("gc_config/cookies").get();
          if (cookieDoc.exists) {
            const data = cookieDoc.data();
            if (data.cookies) {
              gcCookies = JSON.parse(data.cookies);
              console.log(`Loaded ${gcCookies.length} saved GC cookies`);
            }
            if (data.localStorage) {
              gcLocalStorage = JSON.parse(data.localStorage);
              console.log(`Loaded ${Object.keys(gcLocalStorage).length} localStorage items`);
            }
          }
          if (!gcCookies && !gcLocalStorage) {
            console.log("No saved GC auth found — data may be anonymized");
          }
        } catch (e) {
          console.log("Error loading auth:", e.message);
        }

        const limit = Math.min(maxGames || 50, 50);

        let browser;
        try {
          console.log("Starting scrape for:", teamUrl);
          browser = await launchBrowser();
          console.log("Browser launched successfully");

          const result = await scrapeTeam(browser, teamUrl, limit, gcCookies, gcLocalStorage);
          console.log("Scrape complete. Games found:", result.games ? result.games.length : 0);
          res.json(result);
        } catch (err) {
          console.error("Scrape error:", err.message, err.stack);
          res.status(500).json({error: err.message});
        } finally {
          if (browser) await browser.close();
        }
      });
    });

/**
 * Scrape the team schedule to find all game links, then scrape each game.
 */
async function scrapeTeam(browser, teamUrl, maxGames, gcCookies, gcLocalStorage) {
  const page = await browser.newPage();
  await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/120.0.0.0 Safari/537.36",
  );

  // Inject saved GC cookies for schedule page (no localStorage needed here)
  if (gcCookies && gcCookies.length > 0) {
    console.log(`Injecting ${gcCookies.length} GC cookies for schedule`);
    await page.setCookie(...gcCookies);
  }

  // Build schedule URL
  let scheduleUrl = teamUrl.replace(/\/+$/, "");
  if (!scheduleUrl.includes("/schedule")) {
    // If URL has a season slug, we need to append /schedule to the full path
    scheduleUrl += "/schedule";
  }

  console.log("Navigating to schedule:", scheduleUrl);
  await page.goto(scheduleUrl, {waitUntil: "networkidle2", timeout: 30000});
  await delay(3000);
  const schedUrl = await page.url();
  console.log("Schedule page loaded, current URL:", schedUrl);

  // Log page state for debugging
  const pageDebug = await page.evaluate(() => {
    const anchors = document.querySelectorAll("a");
    const schedLinks = [];
    for (const a of anchors) {
      const href = a.getAttribute("href") || "";
      if (href.includes("/schedule/")) {
        schedLinks.push(href.substring(0, 80));
      }
    }
    return {
      totalAnchors: anchors.length,
      scheduleLinks: schedLinks.length,
      firstFew: schedLinks.slice(0, 3),
      mainText: (document.querySelector("main")?.innerText || "").substring(0, 300),
    };
  });
  console.log("Schedule debug:", JSON.stringify(pageDebug));

  // Extract team name — primary method: derive from the URL slug
  // URL format: /teams/TEAMID/2026-spring-robinson-varsity-senators
  // The season slug contains the team name after the season prefix
  let teamName = "";
  {
    const urlParts = teamUrl.replace(/\/+$/, "").split("/");
    // Find the season slug (e.g. "2026-spring-robinson-varsity-senators")
    const seasonSlug = urlParts.find((p) =>
      p.match(/^\d{4}-/) && p.length > 10,
    );
    if (seasonSlug) {
      // Remove the year-season prefix (e.g. "2026-spring-")
      const withoutPrefix = seasonSlug.replace(
          /^\d{4}-(?:spring|summer|fall|winter)-/i, "",
      );
      if (withoutPrefix && withoutPrefix !== seasonSlug) {
        // Convert slug to title case: "robinson-varsity-senators" →
        // "Robinson Varsity Senators"
        teamName = withoutPrefix
            .split("-")
            .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
            .join(" ");
      }
    }
  }

  // Fallback: try to find team name from page content
  if (!teamName) {
    teamName = await page.evaluate(() => {
      // Look for the team name in nav/breadcrumb links that point
      // to this team's page (not game links)
      const links = document.querySelectorAll('a[href*="/teams/"]');
      for (const link of links) {
        const href = link.href || "";
        const text = link.innerText.trim();
        // Only consider links pointing to the team page itself
        // (not /schedule/ game links), and filter out nav items
        if (text.length > 3 && text.length < 60 &&
            !href.includes("/schedule/") &&
            !text.includes("Home") && !text.includes("Schedule") &&
            text !== "HOME" && text !== "AWAY" &&
            !text.match(/^(@|vs\.)/) &&
            !text.match(/[WLT]\s+\d+-\d+/)) {
          return text;
        }
      }
      // Last fallback: page title
      return document.title
          .replace(/GameChanger/gi, "").replace(/\|/g, "").trim();
    });
  }
  console.log("Team name extracted:", teamName);

  // Extract all game links from the schedule
  const gameLinks = await page.evaluate(() => {
    const links = document.querySelectorAll("a[href*=\"/schedule/\"]");
    const games = [];
    const seen = new Set();

    links.forEach((link) => {
      const href = link.href;
      const parts = href.split("/schedule/");
      if (parts.length > 1) {
        const gameId = parts[1].split("/")[0];
        if (gameId && gameId.length > 10 && !seen.has(gameId)) {
          seen.add(gameId);
          games.push({
            id: gameId,
            baseUrl: parts[0] + "/schedule/" + gameId,
            text: link.innerText.trim().substring(0, 100),
          });
        }
      }
    });

    return games;
  });

  // Also try extracting from buttons (home page uses buttons not links)
  if (gameLinks.length === 0) {
    const buttonGames = await page.evaluate(() => {
      const buttons = document.querySelectorAll("button");
      const games = [];
      buttons.forEach((btn) => {
        const text = btn.innerText.trim();
        if ((text.includes("W ") || text.includes("L ") ||
             text.includes("T ")) && text.includes("-")) {
          // This looks like a game result button
          games.push({text});
        }
      });
      return games;
    });

    if (buttonGames.length > 0 && gameLinks.length === 0) {
      // Navigate to the full schedule page
      const fullSchedUrl = teamUrl.replace(/\/+$/, "");
      const schedLink = await page.evaluate(() => {
        const a = document.querySelector('a[href*="/schedule"]');
        return a ? a.href : null;
      });
      if (schedLink) {
        await page.goto(schedLink, {
          waitUntil: "networkidle2",
          timeout: 30000,
        });
        await delay(3000);

        // Re-extract links
        const newLinks = await page.evaluate(() => {
          const anchors = document.querySelectorAll("a[href*=\"/schedule/\"]");
          const result = [];
          const seen = new Set();
          anchors.forEach((a) => {
            const href = a.href;
            const parts = href.split("/schedule/");
            if (parts.length > 1) {
              const gameId = parts[1].split("/")[0];
              if (gameId && gameId.length > 10 && !seen.has(gameId)) {
                seen.add(gameId);
                result.push({
                  id: gameId,
                  baseUrl: parts[0] + "/schedule/" + gameId,
                  text: a.innerText.trim().substring(0, 100),
                });
              }
            }
          });
          return result;
        });
        gameLinks.push(...newLinks);
      }
    }
  }

  await page.close();

  const gamesToScrape = gameLinks.slice(0, maxGames);
  const games = [];

  for (let i = 0; i < gamesToScrape.length; i++) {
    const game = gamesToScrape[i];
    try {
      const gameData = await scrapeGame(browser, game, gcCookies, gcLocalStorage);
      games.push(gameData);
    } catch (err) {
      console.error(`Error scraping game ${game.id}:`, err.message);
      games.push({
        id: game.id,
        error: err.message,
        label: game.text,
      });
    }
  }

  return {
    teamName,
    teamUrl,
    gamesFound: gameLinks.length,
    gamesScraped: games.length,
    games,
  };
}

/**
 * Clear all browser state for a page using CDP commands.
 * This clears HTTP cache, cookies, service workers, and all site storage
 * to ensure each game gets a completely fresh load.
 */
async function clearBrowserState(page) {
  const client = await page.createCDPSession();
  try {
    await client.send("Network.clearBrowserCache");
    await client.send("Network.clearBrowserCookies");
    // Clear cache and service workers but preserve localStorage (auth tokens)
    const clearTypes = "cache_storage,service_workers,indexeddb,websql";
    await client.send("Storage.clearDataForOrigin", {
      origin: "https://web.gc.com",
      storageTypes: clearTypes,
    });
    await client.send("Storage.clearDataForOrigin", {
      origin: "https://www.gc.com",
      storageTypes: clearTypes,
    });
  } catch (e) {
    console.log("CDP clear warning (non-fatal):", e.message);
  } finally {
    await client.detach();
  }
}

/**
 * Scrape a single game's box score and play-by-play.
 * Uses CDP to clear all cached state before each game to prevent
 * the GC SPA from serving stale data.
 */
async function scrapeGame(browser, gameInfo, gcCookies, gcLocalStorage) {
  const page = await browser.newPage();
  try {
  await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/120.0.0.0 Safari/537.36",
  );

  // Clear cached state (preserves localStorage) before loading this game
  await clearBrowserState(page);
  await page.setCacheEnabled(false);

  // Re-inject GC cookies after clearing state
  if (gcCookies && gcCookies.length > 0) {
    await page.setCookie(...gcCookies);
  }

  // Inject localStorage auth tokens
  if (gcLocalStorage && Object.keys(gcLocalStorage).length > 0) {
    await page.goto("https://web.gc.com/favicon.ico", {
      waitUntil: "load", timeout: 10000,
    }).catch(() => {});
    await page.evaluate((items) => {
      for (const [key, value] of Object.entries(items)) {
        localStorage.setItem(key, value);
      }
    }, gcLocalStorage);
  }

  const result = {
    id: gameInfo.id,
    label: gameInfo.text,
    dateInfo: "",
    teams: {home: "", away: ""},
    linescore: null,
    boxScore: {home: null, away: null},
    plays: "",
  };

  // ─── BOX SCORE ───
  const boxUrl = gameInfo.baseUrl + "/box-score";
  console.log(`Game ${gameInfo.id}: loading box score from ${boxUrl}`);
  // Navigate to blank, clear state, re-inject auth, then load box score
  await page.goto("about:blank", {waitUntil: "load"});
  await clearBrowserState(page);
  if (gcCookies && gcCookies.length > 0) await page.setCookie(...gcCookies);
  if (gcLocalStorage && Object.keys(gcLocalStorage).length > 0) {
    await page.goto("https://web.gc.com/favicon.ico", {
      waitUntil: "load", timeout: 10000,
    }).catch(() => {});
    await page.evaluate((items) => {
      for (const [key, value] of Object.entries(items)) {
        localStorage.setItem(key, value);
      }
    }, gcLocalStorage);
  }
  await page.goto(boxUrl, {waitUntil: "networkidle2", timeout: 30000});
  await delay(3000);

  // Get date info
  result.dateInfo = await page.evaluate(() => {
    const el = document.querySelector("main");
    if (!el) return "";
    const text = el.innerText;
    const match = text.match(
        /(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\w+\s+\d+.*?(AM|PM)\s+\w+/,
    );
    return match ? match[0] : "";
  });

  // Get team names from box score page links
  const teamNames = await page.evaluate(() => {
    const els = document.querySelectorAll("main a[href*=\"/teams/\"]");
    const navTabs = new Set([
      "RECAP", "BOX SCORE", "PLAYS", "VIDEOS", "INFO",
      "HOME", "AWAY", "SCHEDULE", "STATS", "ROSTER",
    ]);
    const names = [];
    els.forEach((el) => {
      const t = el.innerText.trim();
      if (t.length > 3 && !navTabs.has(t.toUpperCase())) {
        names.push(t);
      }
    });
    return names;
  });
  if (teamNames.length >= 2) {
    result.teams.home = teamNames[0];
    result.teams.away = teamNames[1];
  } else if (teamNames.length === 1) {
    result.teams.home = teamNames[0];
  }

  // Get linescore
  result.linescore = await page.evaluate(() => {
    const tables = document.querySelectorAll("main table");
    if (tables.length < 3) return null;

    // Team abbreviations
    const teamRows = tables[0].querySelectorAll("tr");
    const teamAbbrs = [];
    teamRows.forEach((r) => {
      const td = r.querySelector("td");
      if (td) teamAbbrs.push(td.innerText.trim());
    });

    // Inning scores
    const inningHeaders = Array.from(tables[1].querySelectorAll("th"))
        .map((th) => th.innerText.trim());
    const inningRows = tables[1].querySelectorAll("tbody tr");
    const innings = [];
    inningRows.forEach((r) => {
      innings.push(
          Array.from(r.querySelectorAll("td"))
              .map((td) => td.innerText.trim()),
      );
    });

    // R/H/E
    const rheHeaders = Array.from(tables[2].querySelectorAll("th"))
        .map((th) => th.innerText.trim());
    const rheRows = tables[2].querySelectorAll("tbody tr");
    const rhe = [];
    rheRows.forEach((r) => {
      rhe.push(
          Array.from(r.querySelectorAll("td"))
              .map((td) => td.innerText.trim()),
      );
    });

    return {teamAbbrs, inningHeaders, innings, rheHeaders, rhe};
  });

  // Get structured box score data
  result.boxScore = await page.evaluate(() => {
    const main = document.querySelector("main");
    if (!main) return {home: null, away: null};

    const text = main.innerText;
    // Check if the page actually has lineup data (not just a loading state)
    if (!text.includes("LINEUP") && !text.includes("AB")) {
      return {fullText: "", note: "No box score data found on page"};
    }
    return {fullText: text};
  });

  // Log box score details to verify each game has unique data
  const currentBoxUrl = await page.url();
  const boxPreview = (result.boxScore.fullText || "").substring(0, 120);
  console.log(`Game ${gameInfo.id}: box score ${
    result.boxScore.fullText ? result.boxScore.fullText.length + " chars" :
    "EMPTY"} (url: ${currentBoxUrl})`);
  console.log(`Game ${gameInfo.id}: preview: ${boxPreview}`);

  // If box score was empty, try one more time after a longer wait
  if (!result.boxScore.fullText) {
    console.log(`Game ${gameInfo.id}: retrying box score after delay...`);
    await page.reload({waitUntil: "networkidle2", timeout: 30000});
    await delay(5000);
    result.boxScore = await page.evaluate(() => {
      const main = document.querySelector("main");
      if (!main) return {home: null, away: null};
      const text = main.innerText;
      if (!text.includes("LINEUP") && !text.includes("AB")) {
        return {fullText: "", note: "No box score data after retry"};
      }
      return {fullText: text};
    });
    console.log(`Game ${gameInfo.id}: retry box score ${
      result.boxScore.fullText ? result.boxScore.fullText.length + " chars" :
      "STILL EMPTY"}`);
  }

  // ─── PLAY BY PLAY ───
  const playsUrl = gameInfo.baseUrl + "/plays";
  console.log(`Game ${gameInfo.id}: loading plays from ${playsUrl}`);
  // Clear state, re-inject auth, then load plays page
  await page.goto("about:blank", {waitUntil: "load"});
  await clearBrowserState(page);
  if (gcCookies && gcCookies.length > 0) await page.setCookie(...gcCookies);
  if (gcLocalStorage && Object.keys(gcLocalStorage).length > 0) {
    await page.goto("https://web.gc.com/favicon.ico", {
      waitUntil: "load", timeout: 10000,
    }).catch(() => {});
    await page.evaluate((items) => {
      for (const [key, value] of Object.entries(items)) {
        localStorage.setItem(key, value);
      }
    }, gcLocalStorage);
  }
  await page.goto(playsUrl, {waitUntil: "networkidle2", timeout: 30000});
  await delay(3000);

  // Scroll to load all plays
  let prevHeight = 0;
  for (let i = 0; i < 20; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await delay(500);
    const currHeight = await page.evaluate(() => document.body.scrollHeight);
    if (currHeight === prevHeight) break;
    prevHeight = currHeight;
  }

  // Extract structured play-by-play
  result.plays = await page.evaluate(() => {
    const main = document.querySelector("main");
    if (!main) return "";

    // Get the plays section text
    const playsDiv = main.querySelector("h1");
    if (!playsDiv) return main.innerText;

    // Get everything after the "Plays" header
    let inPlays = false;
    const lines = [];
    const walker = document.createTreeWalker(
        main, NodeFilter.SHOW_TEXT, null,
    );
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent.trim();
      if (text === "Plays") inPlays = true;
      if (inPlays && text.length > 0 &&
          text !== "All Plays" && text !== "Scoring Plays" &&
          text !== "Outs" && text !== "Player" &&
          text !== "Reverse Chronological" &&
          text !== "Chronological" &&
          text !== "Sign in to GameChanger" &&
          !text.includes("see this team") &&
          !text.includes("schedule, roster")) {
        lines.push(text);
      }
    }

    return lines.join("\n");
  });

  console.log(`Game ${gameInfo.id}: plays ${
    result.plays ? result.plays.length + " chars" : "EMPTY"}`);

  // If plays were empty, try one more time
  if (!result.plays || result.plays.length < 50) {
    console.log(`Game ${gameInfo.id}: retrying plays after delay...`);
    await page.reload({waitUntil: "networkidle2", timeout: 30000});
    await delay(5000);
    // Scroll again
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() =>
        window.scrollTo(0, document.body.scrollHeight));
      await delay(500);
    }
    result.plays = await page.evaluate(() => {
      const main = document.querySelector("main");
      if (!main) return "";
      const playsDiv = main.querySelector("h1");
      if (!playsDiv) return main.innerText;
      let inPlays = false;
      const lines = [];
      const walker = document.createTreeWalker(
          main, NodeFilter.SHOW_TEXT, null,
      );
      let node;
      while ((node = walker.nextNode())) {
        const text = node.textContent.trim();
        if (text === "Plays") inPlays = true;
        if (inPlays && text.length > 0 &&
            text !== "All Plays" && text !== "Scoring Plays" &&
            text !== "Outs" && text !== "Player" &&
            text !== "Reverse Chronological" &&
            text !== "Chronological" &&
            text !== "Sign in to GameChanger" &&
            !text.includes("see this team") &&
            !text.includes("schedule, roster")) {
          lines.push(text);
        }
      }
      return lines.join("\n");
    });
    console.log(`Game ${gameInfo.id}: retry plays ${
      result.plays ? result.plays.length + " chars" : "STILL EMPTY"}`);
  }

  return result;
  } finally {
    await page.close();
  }
}

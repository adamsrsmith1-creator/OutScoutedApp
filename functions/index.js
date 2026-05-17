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

          // Login succeeded — save cookies and extract GC-Token JWT
          console.log("gcLogin: login succeeded, saving auth data");
          const cookies = await page.cookies();

          // Extract GC-Token JWT by intercepting API requests
          let gcToken = "";
          try {
            // Navigate to a page that triggers API calls with GC-Token
            const client = await page.createCDPSession();
            let capturedToken = "";
            client.on("Network.requestWillBeSent", (params) => {
              const gcTok = (params.request.headers || {})["GC-Token"] ||
                  (params.request.headers || {})["gc-token"] || "";
              if (gcTok && gcTok.length > 100) capturedToken = gcTok;
            });
            await client.send("Network.enable");
            await page.goto("https://web.gc.com/", {
              waitUntil: "networkidle2", timeout: 15000,
            });
            await delay(3000);
            gcToken = capturedToken;
            await client.detach();
          } catch (e) {
            console.log("gcLogin: error capturing GC-Token:", e.message);
          }

          // Also save eden-auth-tokens for token auto-refresh
          let edenTokens = "";
          try {
            edenTokens = await page.evaluate(() => {
              return localStorage.getItem("eden-auth-tokens") || "";
            });
          } catch (e) {
            console.log("gcLogin: error reading eden-auth-tokens:", e.message);
          }

          const saveData = {
            cookies: JSON.stringify(cookies),
            savedAt: admin.firestore.FieldValue.serverTimestamp(),
            email: gcEmail,
          };
          if (gcToken) {
            saveData.gcToken = gcToken;
            console.log(`gcLogin: saved GC-Token JWT (${gcToken.length} chars)`);
          }
          if (edenTokens) {
            saveData.edenAuthTokens = edenTokens;
            console.log(`gcLogin: saved eden-auth-tokens (${edenTokens.length} chars)`);
          }
          await db.doc("gc_config/cookies").set(saveData);
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

        // Load saved GC auth (JWT token for API calls + cookies for schedule)
        let gcCookies = null;
        let gcToken = null;
        let edenAuthTokens = null;
        try {
          const cookieDoc = await db.doc("gc_config/cookies").get();
          if (cookieDoc.exists) {
            const data = cookieDoc.data();
            if (data.cookies) {
              gcCookies = JSON.parse(data.cookies);
              console.log(`Loaded ${gcCookies.length} saved GC cookies`);
            }
            if (data.gcToken) {
              gcToken = data.gcToken;
              console.log(`Loaded GC-Token JWT (${gcToken.length} chars)`);
            }
            if (data.edenAuthTokens) {
              edenAuthTokens = data.edenAuthTokens;
              console.log(`Loaded eden-auth-tokens (${edenAuthTokens.length} chars)`);
            }
          }
          if (!gcToken) {
            console.log("No GC-Token found — data may be anonymized");
          }
        } catch (e) {
          console.log("Error loading auth:", e.message);
        }

        // Check if GC-Token is still valid, refresh if needed
        if (gcToken) {
          try {
            const testRes = await fetch(
                "https://api.team-manager.gc.com/me/user",
                {headers: {"GC-Token": gcToken, "Accept": "application/json"}},
            );
            if (testRes.ok) {
              console.log("GC-Token is valid");
            } else {
              console.log(`GC-Token expired (${testRes.status}), attempting refresh...`);
              gcToken = null; // Force refresh below
            }
          } catch (e) {
            console.log("Token validation error:", e.message);
          }
        }

        const limit = Math.min(maxGames || 50, 50);

        let browser;
        try {
          console.log("Starting scrape for:", teamUrl);
          browser = await launchBrowser();
          console.log("Browser launched successfully");

          // If token is expired, try to refresh via Puppeteer
          if (!gcToken && edenAuthTokens) {
            console.log("Attempting token refresh via Puppeteer...");
            gcToken = await refreshGcToken(
                browser, gcCookies, edenAuthTokens,
            );
            if (gcToken) {
              // Save the refreshed token to Firestore
              await db.doc("gc_config/cookies").update({
                gcToken,
                savedAt: admin.firestore.FieldValue.serverTimestamp(),
              });
              console.log("Refreshed and saved new GC-Token");
            }
          }

          const result = await scrapeTeam(
              browser, teamUrl, limit, gcCookies, gcToken,
          );
          console.log("Scrape complete. Games found:",
              result.games ? result.games.length : 0);
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
 * Refresh the GC-Token JWT by loading gc.com with saved auth tokens.
 * The eden SDK in gc.com decrypts the saved tokens and generates a fresh JWT.
 */
async function refreshGcToken(browser, gcCookies, edenAuthTokens) {
  let freshToken = "";
  const page = await browser.newPage();
  try {
    await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/120.0.0.0 Safari/537.36",
    );

    // Set up CDP network interception to capture GC-Token
    const client = await page.createCDPSession();
    client.on("Network.requestWillBeSent", (params) => {
      const tok = (params.request.headers || {})["GC-Token"] ||
          (params.request.headers || {})["gc-token"] || "";
      if (tok && tok.length > 100 && !freshToken) {
        freshToken = tok;
      }
    });
    await client.send("Network.enable");

    // Inject cookies
    if (gcCookies && gcCookies.length > 0) {
      await page.setCookie(...gcCookies);
    }

    // Navigate to gc.com to set localStorage
    await page.goto("https://web.gc.com/favicon.ico", {timeout: 10000});
    await delay(500);

    // Inject eden-auth-tokens into localStorage
    await page.evaluate((tokens) => {
      localStorage.setItem("eden-auth-tokens", tokens);
    }, edenAuthTokens);

    // Navigate to gc.com — the eden SDK will decrypt tokens and make API calls
    await page.goto("https://web.gc.com/", {
      waitUntil: "domcontentloaded", timeout: 20000,
    });
    await delay(5000);

    if (freshToken) {
      // Validate the captured token
      const testRes = await fetch(
          "https://api.team-manager.gc.com/me/user",
          {headers: {"GC-Token": freshToken, "Accept": "application/json"}},
      );
      if (testRes.ok) {
        console.log(`Token refresh successful (${freshToken.length} chars)`);

        // Also save updated eden-auth-tokens (SDK may have refreshed them)
        const updatedTokens = await page.evaluate(() => {
          return localStorage.getItem("eden-auth-tokens");
        });
        if (updatedTokens && updatedTokens !== edenAuthTokens) {
          await db.doc("gc_config/cookies").update({
            edenAuthTokens: updatedTokens,
          });
          console.log("Updated eden-auth-tokens in Firestore");
        }
      } else {
        console.log(`Refreshed token invalid (${testRes.status})`);
        freshToken = "";
      }
    } else {
      console.log("No GC-Token captured during refresh attempt");
    }

    await client.detach();
  } catch (e) {
    console.log("Token refresh error:", e.message);
  } finally {
    await page.close();
  }
  return freshToken || null;
}

/**
 * Scrape the team schedule to find all game links, then scrape each game.
 */
async function scrapeTeam(browser, teamUrl, maxGames, gcCookies, gcToken) {
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

  // Extract team ID from URL for API calls
  const teamIdMatch = teamUrl.match(/\/teams\/([^/]+)/);
  const teamId = teamIdMatch ? teamIdMatch[1] : null;

  const gamesToScrape = gameLinks.slice(0, maxGames);
  const games = [];

  for (let i = 0; i < gamesToScrape.length; i++) {
    const game = gamesToScrape[i];
    try {
      const gameData = await fetchGameFromAPI(game, gcToken, teamId);
      games.push(gameData);
    } catch (err) {
      console.error(`Error fetching game ${game.id}:`, err.message);
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
 * Fetch a single game's data from the GC API.
 * Uses direct API calls instead of browser rendering — much faster and
 * more reliable than scraping the React SPA.
 */
async function fetchGameFromAPI(gameInfo, gcToken, teamId) {
  const gameId = gameInfo.id;
  const apiBase = "https://api.team-manager.gc.com";
  const headers = {"Accept": "application/json"};
  if (gcToken) headers["GC-Token"] = gcToken;

  console.log(`Game ${gameId}: fetching via API`);

  // Fetch game details (date, score, line score)
  const detailsRes = await fetch(
      `${apiBase}/public/game-stream-processing/${gameId}/details?include=line_score`,
      {headers},
  );
  const details = detailsRes.ok ? await detailsRes.json() : {};

  // Fetch boxscore (players + batting/pitching stats)
  const boxRes = await fetch(
      `${apiBase}/game-stream-processing/${gameId}/boxscore`,
      {headers},
  );
  if (!boxRes.ok) {
    console.log(`Game ${gameId}: boxscore API returned ${boxRes.status}`);
  }
  const boxData = boxRes.ok ? await boxRes.json() : {};

  // Fetch play-by-play
  const playsRes = await fetch(
      `${apiBase}/game-stream-processing/${gameId}/plays`,
      {headers},
  );
  if (!playsRes.ok) {
    console.log(`Game ${gameId}: plays API returned ${playsRes.status}`);
  }
  const playsData = playsRes.ok ? await playsRes.json() : {};

  // Build player lookup from boxscore data
  const allPlayers = {};
  for (const [tid, tdata] of Object.entries(boxData)) {
    if (tdata.players) {
      for (const p of tdata.players) {
        allPlayers[p.id] = `${p.first_name} ${p.last_name}`;
      }
    }
  }
  // Also add from plays data
  if (playsData.team_players) {
    for (const [tid, players] of Object.entries(playsData.team_players)) {
      for (const p of players) {
        allPlayers[p.id] = `${p.first_name} ${p.last_name}`;
      }
    }
  }

  // Determine home/away teams
  const opponentName = details.opponent_team?.name || "";
  const homeAway = details.home_away || "home";

  // Build box score text in the format the existing parser expects
  const boxText = formatBoxScoreText(
      boxData, details, allPlayers, teamId, gameInfo.text,
  );

  // Build play-by-play text
  const playsText = formatPlaysText(
      playsData, allPlayers, details,
  );

  // Format date info
  let dateInfo = "";
  if (details.start_ts) {
    const d = new Date(details.start_ts);
    const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    dateInfo = `${days[d.getDay()]} ${months[d.getMonth()]} ${d.getDate()}`;
  }

  console.log(`Game ${gameId}: box ${boxText.length} chars, ` +
      `plays ${playsText.length} chars`);

  return {
    id: gameId,
    label: gameInfo.text,
    dateInfo,
    teams: {
      home: homeAway === "home" ? "" : opponentName,
      away: homeAway === "away" ? "" : opponentName,
    },
    linescore: details.line_score || null,
    boxScore: {fullText: boxText},
    plays: playsText,
  };
}

/**
 * Format boxscore API data into text that matches the existing parser.
 */
function formatBoxScoreText(boxData, details, allPlayers, teamId) {
  const lines = [];

  // Date header
  if (details.start_ts) {
    const d = new Date(details.start_ts);
    lines.push(d.toLocaleDateString("en-US", {
      weekday: "short", month: "short", day: "numeric",
    }));
  }
  lines.push("FINAL");

  // Line score
  if (details.line_score) {
    const ls = details.line_score;
    const innings = ls.team?.scores || [];
    lines.push(innings.join("\t"));
    lines.push("R\tH\tE");
    const tt = ls.team?.totals || [];
    const ot = ls.opponent_team?.totals || [];
    lines.push(tt.join("\t"));
    lines.push(ot.join("\t"));
  }

  // Format each team's batting and pitching
  for (const [tid, tdata] of Object.entries(boxData)) {
    const players = {};
    if (tdata.players) {
      for (const p of tdata.players) {
        players[p.id] = p;
      }
    }

    const groups = tdata.groups || [];
    for (const group of groups) {
      const cat = group.category || "";

      if (cat === "lineup") {
        // Batting section
        lines.push("LINEUP\tAB\tR\tH\tRBI\tBB\tSO");
        for (const s of (group.stats || [])) {
          const p = players[s.player_id] || {};
          const name = `${p.first_name || "?"} ${p.last_name || "?"}`;
          const num = p.number || "";
          const pos = s.player_text || "";
          const st = s.stats || {};
          lines.push(`${name}\n#${num} ${pos}\n${st.AB || 0}\t` +
              `${st.R || 0}\t${st.H || 0}\t${st.RBI || 0}\t` +
              `${st.BB || 0}\t${st.SO || 0}`);
        }
        // Team totals
        const ts = group.team_stats || {};
        lines.push(`TEAM\t${ts.AB || 0}\t${ts.R || 0}\t${ts.H || 0}\t` +
            `${ts.RBI || 0}\t${ts.BB || 0}\t${ts.SO || 0}`);

        // Extra stats (HR, 2B, TB, SB, etc.)
        for (const extra of (group.extra || [])) {
          const statName = extra.stat_name || "";
          const entries = (extra.stats || []).map((e) => {
            const p = players[e.player_id] || {};
            const name = `${p.first_name || "?"} ${p.last_name || "?"}`;
            return e.value > 1 ? `${name} ${e.value}` : name;
          });
          if (entries.length > 0) {
            lines.push(`${statName}: ${entries.join(", ")}`);
          }
        }
      } else if (cat === "pitching") {
        // Pitching section
        lines.push("PITCHING\tIP\tH\tR\tER\tBB\tSO");
        for (const s of (group.stats || [])) {
          const p = players[s.player_id] || {};
          const name = `${p.first_name || "?"} ${p.last_name || "?"}`;
          const num = p.number || "";
          const st = s.stats || {};
          lines.push(`${name}\n#${num}\n${st.IP || 0}\t` +
              `${st.H || 0}\t${st.R || 0}\t${st.ER || 0}\t` +
              `${st.BB || 0}\t${st.SO || 0}`);
        }
        const ts = group.team_stats || {};
        lines.push(`TEAM\t${ts.IP || 0}\t${ts.H || 0}\t${ts.R || 0}\t` +
            `${ts.ER || 0}\t${ts.BB || 0}\t${ts.SO || 0}`);

        // Pitching extras (Pitches-Strikes, Batters Faced, etc.)
        for (const extra of (group.extra || [])) {
          const statName = extra.stat_name || "";
          const entries = (extra.stats || []).map((e) => {
            const p = players[e.player_id] || {};
            const name = `${p.first_name || "?"} ${p.last_name || "?"}`;
            return `${name} ${e.value}`;
          });
          if (entries.length > 0) {
            lines.push(`${statName}: ${entries.join(", ")}`);
          }
        }
      }
    }
  }

  return lines.join("\n");
}

/**
 * Format play-by-play API data into text that matches the existing parser.
 */
function formatPlaysText(playsData, allPlayers) {
  if (!playsData.plays || playsData.plays.length === 0) return "";

  const lines = [];
  let currentInning = 0;
  let currentHalf = "";

  for (const play of playsData.plays) {
    // Inning headers
    if (play.inning !== currentInning || play.half !== currentHalf) {
      currentInning = play.inning;
      currentHalf = play.half;
      const halfLabel = currentHalf === "top" ? "Top" : "Bottom";
      lines.push(`${halfLabel} ${currentInning}`);
    }

    // Play name
    const playName = play.name_template?.template || "";
    lines.push(playName);

    // Score if changed
    if (play.did_score_change) {
      lines.push(`${play.away_score}-${play.home_score}`);
    }

    // Pitch sequence
    const pitches = (play.at_plate_details || [])
        .map((d) => d.template || "").filter((t) => t);
    if (pitches.length > 0) {
      lines.push(pitches.join(", "));
    }

    // Play description — resolve player IDs in templates
    for (const detail of (play.final_details || [])) {
      let text = detail.template || "";
      // Replace ${player-id} with player names
      text = text.replace(/\$\{([^}]+)\}/g, (match, id) => {
        return allPlayers[id] || match;
      });
      if (text) lines.push(text);
    }

    // Messages (lineup changes, etc.)
    for (const msg of (play.messages || [])) {
      let text = msg.template || "";
      text = text.replace(/\$\{([^}]+)\}/g, (match, id) => {
        return allPlayers[id] || match;
      });
      if (text) lines.push(text);
    }
  }

  return lines.join("\n");
}

const functions = require("firebase-functions");
const admin = require("firebase-admin");
const cors = require("cors")({origin: true});

admin.initializeApp();

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * scrapeGameChanger – Firebase Cloud Function
 *
 * Accepts a GameChanger team URL, scrapes the schedule page to find all games,
 * then scrapes each game's box score and play-by-play data.
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

        // Verify Firebase Auth token
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
          res.status(401).json({error: "Unauthorized"});
          return;
        }
        const ADMIN_EMAIL = "adamsrsmith1@gmail.com";
        try {
          const idToken = authHeader.split("Bearer ")[1];
          const decodedToken = await admin.auth().verifyIdToken(idToken);
          if (decodedToken.email !== ADMIN_EMAIL) {
            res.status(403).json({error: "Admin access required"});
            return;
          }
        } catch (authErr) {
          res.status(401).json({error: "Invalid auth token"});
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

        const limit = Math.min(maxGames || 50, 50);

        let browser;
        try {
          console.log("Starting scrape for:", teamUrl);
          const chromium = require("@sparticuz/chromium");
          const puppeteer = require("puppeteer-core");
          console.log("Chromium exec path:", await chromium.executablePath());
          browser = await puppeteer.launch({
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
          });
          console.log("Browser launched successfully");

          const result = await scrapeTeam(browser, teamUrl, limit);
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
async function scrapeTeam(browser, teamUrl, maxGames) {
  const page = await browser.newPage();
  await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/120.0.0.0 Safari/537.36",
  );

  // Build schedule URL
  let scheduleUrl = teamUrl.replace(/\/+$/, "");
  if (!scheduleUrl.includes("/schedule")) {
    // If URL has a season slug, we need to append /schedule to the full path
    scheduleUrl += "/schedule";
  }

  console.log("Navigating to schedule:", scheduleUrl);
  await page.goto(scheduleUrl, {waitUntil: "networkidle2", timeout: 30000});
  await delay(3000);
  console.log("Schedule page loaded");

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
      const gameData = await scrapeGame(browser, game);
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
 * Scrape a single game's box score and play-by-play.
 * Uses an incognito browser context per game to ensure completely isolated
 * storage — no shared service workers, HTTP cache, or SPA state between games.
 */
async function scrapeGame(browser, gameInfo) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  try {
  await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
      "AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/120.0.0.0 Safari/537.36",
  );

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
    await context.close();
  }
}

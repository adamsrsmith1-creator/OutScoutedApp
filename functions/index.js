const functions = require("firebase-functions");
const admin = require("firebase-admin");
const cors = require("cors")({origin: true});

admin.initializeApp();

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
          const chromium = require("@sparticuz/chromium");
          const puppeteer = require("puppeteer-core");
          browser = await puppeteer.launch({
            args: chromium.args,
            defaultViewport: chromium.defaultViewport,
            executablePath: await chromium.executablePath(),
            headless: chromium.headless,
          });

          const result = await scrapeTeam(browser, teamUrl, limit);
          res.json(result);
        } catch (err) {
          console.error("Scrape error:", err);
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

  await page.goto(scheduleUrl, {waitUntil: "networkidle2", timeout: 30000});
  await page.waitForTimeout(3000);

  // Extract team name
  const teamName = await page.evaluate(() => {
    // Try the team header area
    const links = document.querySelectorAll('a[href*="/teams/"]');
    for (const link of links) {
      const text = link.innerText.trim();
      if (text.length > 3 && !text.includes("Home") &&
          !text.includes("Schedule")) {
        return text;
      }
    }
    // Fallback: page title
    return document.title.replace("GameChanger", "").replace("|", "").trim();
  });

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
        await page.waitForTimeout(3000);

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
 */
async function scrapeGame(browser, gameInfo) {
  const page = await browser.newPage();
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
  await page.goto(boxUrl, {waitUntil: "networkidle2", timeout: 30000});
  await page.waitForTimeout(2000);

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

  // Get team names
  const teamNames = await page.evaluate(() => {
    const els = document.querySelectorAll("main a[href*=\"/teams/\"]");
    const names = [];
    els.forEach((el) => {
      const t = el.innerText.trim();
      if (t.length > 0) names.push(t);
    });
    return names;
  });
  if (teamNames.length > 0) result.teams.home = teamNames[0];

  // Get opponent name (not a link, just text with SVG icon)
  const opponentName = await page.evaluate((teamNamesArg) => {
    const main = document.querySelector("main");
    if (!main) return "";
    const divs = main.querySelectorAll("div");
    for (const div of divs) {
      const text = div.innerText.trim();
      if (text.includes("Varsity") || text.includes("JV") ||
          text.includes("Bulldogs") || text.includes("Eagles") ||
          text.includes("Bears") || text.includes("Panthers") ||
          text.includes("Tigers") || text.includes("Indians") ||
          text.includes("Cardinals") || text.includes("Dragons") ||
          text.includes("Wildcats") || text.includes("Lions") ||
          text.includes("Rams") || text.includes("Hawks") ||
          text.includes("Warriors") || text.includes("Knights")) {
        if (teamNamesArg.length > 0 && text !== teamNamesArg[0] &&
            !text.includes("LINEUP") && !text.includes("PITCHING") &&
            text.length < 60) {
          return text;
        }
      }
    }
    return "";
  }, teamNames);
  result.teams.away = opponentName;

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

    // The box score has two team sections, each with LINEUP and PITCHING
    const text = main.innerText;

    // Just get the full text — we'll parse it on the client side
    // where the existing parser already knows how to handle this format
    return {fullText: text};
  });

  // ─── PLAY BY PLAY ───
  const playsUrl = gameInfo.baseUrl + "/plays";
  await page.goto(playsUrl, {waitUntil: "networkidle2", timeout: 30000});
  await page.waitForTimeout(2000);

  // Scroll to load all plays
  let prevHeight = 0;
  for (let i = 0; i < 20; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(500);
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

  return result;
  } finally {
    await page.close();
  }
}

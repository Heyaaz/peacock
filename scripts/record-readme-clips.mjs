#!/usr/bin/env node
/**
 * Records the README media from the renderer running on the built-in mock backend
 * (`?backend=mock&sample=readme`, the English sample in src/backend/mock-sample-readme.ts).
 * Nothing here touches real sessions or ~/.gjc, and no Electron app is started.
 *
 *   CLIP_PORT=5198 PLAYWRIGHT_CORE=... CHROME=... FFMPEG=... \
 *     node scripts/record-readme-clips.mjs [scene ...]
 *
 * Start the dev server first: `npx vite --port 5198 --strictPort`.
 * Scenes: the feature clips (feature-*.gif), `demo` (demo.gif, demo.mp4) and the two stills
 * (`question-dark`, `done-light`). With no argument every scene is recorded.
 * A clip is back-to-back screenshots taken from the moment its `run` begins, encoded
 * to a GIF in docs/media. The new-session dialog and the empty window offer every agent only
 * where the desktop app runs terminals, so the agent scenes hand those two screens a
 * stand-in for the host's agent list (`AGENTS`); nothing else in the page sees it.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = process.env.CLIP_PORT ?? "5198";
const outDir = process.env.CLIP_OUT ?? join(root, "docs", "media");
const workDir = process.env.CLIP_WORK ?? join(tmpdir(), "peacock-readme-clips");
const ffmpeg = process.env.FFMPEG ?? "ffmpeg";
// Wide enough for the model picker (726px) to open without scrolling the window.
const WIDTH = 1200;
const HEIGHT = 713;
const GIF_WIDTH = 960;
const GIF_FPS = 14;
const SCALE = Number(process.env.CLIP_SCALE ?? 1);
// The demo is recorded larger and shrunk for its GIF; its stills are 1.25x of this.
const DEMO_WIDTH = 1280;
const DEMO_HEIGHT = 760;

// What the scripted request says: keep in step with DEMO_REQUEST in the sample.
const DEMO_REQUEST = /DEMO_REQUEST = "([^"]+)"/u.exec(
  readFileSync(join(root, "src", "backend", "mock-sample-readme.ts"), "utf8"),
)?.[1];
if (!DEMO_REQUEST) throw new Error("DEMO_REQUEST not found in mock-sample-readme.ts");

const AGENTS = [
  { id: "claude", name: "Claude Code", installed: true, version: "2.1.4", binary: "/Users/dev/.local/bin/claude" },
  { id: "omp", name: "Oh My Pi", installed: true, version: "14.2.0", binary: "/Users/dev/.local/bin/omp" },
  { id: "codex", name: "Codex", installed: true, version: "0.64.0", binary: "/opt/homebrew/bin/codex" },
  { id: "gjc", name: "GJC", installed: true, version: "0.19.3", binary: "/Users/dev/.local/bin/gjc" },
  { id: "shell", name: "Shell", installed: true, binary: "/bin/zsh" },
];

const requirePlaywright = createRequire(import.meta.url);
const { chromium } = requirePlaywright(process.env.PLAYWRIGHT_CORE ?? "playwright-core");

const hold = (ms) => new Promise((done) => setTimeout(done, ms));

// A ring that follows the pointer, since a video does not draw the OS cursor.
const POINTER = `(() => {
  const ring = document.createElement("div");
  ring.style.cssText = "position:fixed;z-index:2147483647;pointer-events:none;width:20px;height:20px;margin:-10px 0 0 -10px;border-radius:50%;background:rgba(240,100,22,.3);border:2px solid #ff9238;left:-60px;top:-60px;transition:transform .12s";
  addEventListener("DOMContentLoaded", () => document.documentElement.append(ring));
  addEventListener("mousemove", (e) => { ring.style.left = e.clientX + "px"; ring.style.top = e.clientY + "px"; }, true);
  addEventListener("mousedown", () => { ring.style.transform = "scale(.65)"; }, true);
  addEventListener("mouseup", () => { ring.style.transform = "scale(1)"; }, true);
})();`;

/**
 * English UI, the theme the scene wants and, for the agent scenes, a host stand-in. Only
 * the files that list agents see it; the rest of the page keeps running as a plain browser.
 */
function pageSetup({ language, theme, agents }) {
  localStorage.setItem("gajae:language", language);
  localStorage.setItem("gajae:theme", theme);
  if (!agents) return;
  const bridge = { terminal: { listAgents: async () => agents } };
  Object.defineProperty(window, "agentControlDesktop", {
    configurable: true,
    get: () =>
      /\/(dialogs|empty-workspace-agents|agents-settings-panel)\.tsx/u.test(new Error().stack ?? "") ? bridge : undefined,
  });
}

const pointer = { x: 560, y: 330 };

async function glide(page, target) {
  const box = await target.boundingBox();
  if (!box) throw new Error("glide target has no box");
  const to = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const steps = 22;
  for (let step = 1; step <= steps; step += 1) {
    const t = step / steps;
    const ease = t * t * (3 - 2 * t);
    await page.mouse.move(
      pointer.x + (to.x - pointer.x) * ease,
      pointer.y + (to.y - pointer.y) * ease,
    );
    await hold(14);
  }
  pointer.x = to.x;
  pointer.y = to.y;
}

async function press(page, target, options) {
  await glide(page, target);
  await hold(120);
  await target.click(options);
}

const sidebar = (page) => page.locator(".sidebar");
const sessionRow = (page, title) => sidebar(page).getByText(title, { exact: true }).first();
const composer = (page) => page.locator("form.composer textarea, .composer textarea").first();

async function openSession(page, title) {
  const row = sessionRow(page, title);
  await row.click();
  const box = await row.boundingBox();
  pointer.x = box.x + box.width / 2;
  pointer.y = box.y + box.height / 2;
  await composer(page).waitFor();
}

const SESSIONS = {
  retry: "Add retry with backoff",
  checkout: "Fix flaky checkout test",
  auth: "Refactor auth middleware",
  notes: "Write release notes for 2.4",
  omp: "Upgrade to React 20",
};

const scenes = {
  agents: {
    out: "feature-agents.gif",
    query: "sample=readme-start",
    agents: true,
    ready: (page) => page.locator(".workspace-empty__agents").waitFor(),
    async setup() {},
    async run(page) {
      const chips = page.locator(".workspace-empty__agents");
      await hold(1500);
      await press(page, chips.getByRole("button", { name: "Claude Code" }));
      const dialog = page.locator(".new-session-dialog");
      await dialog.waitFor();
      await hold(1500);
      for (const name of ["Oh My Pi", "Codex", "GJC"]) {
        await press(page, dialog.locator(".agent-options label", { hasText: name }));
        await hold(1300);
        if (name === "Oh My Pi") {
          // omp offers its own chat next to the terminal
          await press(page, dialog.locator(".session-kind-switch").getByText("Chat", { exact: true }));
          await hold(1200);
        }
      }
      await press(page, dialog.locator(".agent-options label", { hasText: "Claude Code" }));
      await hold(2200);
    },
  },

  omp: {
    out: "feature-omp.gif",
    ready: (page) => sessionRow(page, SESSIONS.omp).waitFor(),
    async setup(page) {
      await openSession(page, SESSIONS.omp);
    },
    async run(page) {
      await hold(1500);
      await press(page, page.getByTitle("Todo list"));
      await hold(2000);
      await press(page, page.getByTitle("Todo list"));
      await hold(600);
      await press(page, page.getByTitle("Show context by category"));
      await page.getByText("Usage of this session").waitFor();
      await hold(3200);
      await press(page, page.locator("button.button-primary", { hasText: "Close" }));
      await hold(500);
      await press(page, page.getByTitle("Conversation tree"));
      await page.getByText("You are here").waitFor();
      await hold(3000);
    },
  },

  approval: {
    out: "feature-approval.gif",
    ready: (page) => sessionRow(page, SESSIONS.checkout).waitFor(),
    async setup(page) {
      await openSession(page, SESSIONS.checkout);
      await page.locator(".tool-card-rule").waitFor();
    },
    async run(page) {
      await hold(1100);
      const prefix = page.locator(".tool-card-rule input");
      await press(page, prefix);
      await page.keyboard.press("End");
      await page.keyboard.type(" --short", { delay: 120 });
      await hold(900);
      await press(page, page.getByRole("button", { name: "Always allow this prefix" }));
      await page.locator(".tool-card-auto-decision").waitFor();
      await page.locator(".tool-card-auto-decision").scrollIntoViewIfNeeded();
      await hold(2600);
    },
  },

  "side-chat": {
    out: "feature-side-chat.gif",
    ready: (page) => sessionRow(page, SESSIONS.auth).waitFor(),
    async setup(page) {
      await openSession(page, SESSIONS.auth);
    },
    async run(page) {
      await hold(1200);
      await page.keyboard.press("Meta+Shift+B");
      const input = page.getByLabel("Side chat message");
      await input.waitFor();
      await hold(700);
      await press(page, input);
      await page.keyboard.type("Show the scope of the refactor as a table", { delay: 60 });
      await hold(400);
      await page.keyboard.press("Enter");
      await page.locator(".side-panel table").waitFor({ timeout: 15_000 });
      await hold(3200);
    },
  },

  mermaid: {
    out: "feature-mermaid.gif",
    ready: (page) => sessionRow(page, SESSIONS.notes).waitFor(),
    async setup() {},
    async run(page) {
      await hold(1000);
      await press(page, sessionRow(page, SESSIONS.notes));
      await page.locator(".mermaid-block svg, [class*=mermaid] svg").first().waitFor({ timeout: 15_000 });
      await hold(3400);
    },
  },

  suggestion: {
    out: "feature-suggestion.gif",
    ready: (page) => sessionRow(page, SESSIONS.notes).waitFor(),
    async setup(page) {
      await openSession(page, SESSIONS.notes);
    },
    async run(page) {
      await hold(900);
      await press(page, composer(page));
      await page.keyboard.type("Add a section about breaking changes", { delay: 55 });
      await hold(500);
      await page.keyboard.press("Enter");
      await page.locator(".composer-ghost").waitFor({ timeout: 20_000 });
      await hold(2200);
      await page.keyboard.press("Tab");
      await hold(2200);
    },
  },

  queue: {
    out: "feature-queue.gif",
    ready: (page) => sessionRow(page, SESSIONS.auth).waitFor(),
    async setup(page) {
      await openSession(page, SESSIONS.auth);
    },
    async run(page) {
      await hold(1000);
      await press(page, composer(page));
      for (const text of ["Run the full suite too", "End with a summary of the changes"]) {
        await page.keyboard.type(text, { delay: 50 });
        await hold(250);
        await page.keyboard.press("Enter");
        await page.locator(".composer-queue-item", { hasText: text }).waitFor();
        await hold(600);
      }
      await hold(900);
      await press(page, page.getByRole("button", { name: "Move later" }).first());
      await hold(1300);
      await press(page, page.getByRole("button", { name: "Discard queued item" }).last());
      await hold(1800);
    },
  },

  "model-picker": {
    out: "feature-model-picker.gif",
    ready: (page) => sessionRow(page, SESSIONS.notes).waitFor(),
    async setup(page) {
      await openSession(page, SESSIONS.notes);
      // The picker opens a few pixels wider than the window and would scroll the shell sideways.
      await page.addStyleTag({
        content: ".app-shell { overflow-x: clip !important; } .model-catalog-picker { left: -24px !important; }",
      });
    },
    async run(page) {
      await hold(900);
      await press(page, page.locator(".composer").getByText("Codex Medium").first());
      const picker = page.locator(".model-catalog-picker");
      await picker.waitFor();
      await hold(1300);
      await press(page, picker.getByRole("group", { name: "Thinking level" }).getByRole("button", { name: "high", exact: true }));
      await hold(1000);
      await press(page, picker.getByRole("group", { name: "Fast mode" }).getByRole("button", { name: "Fast on" }));
      await hold(1000);
      await press(page, picker.getByRole("searchbox").or(picker.locator("input").first()));
      await page.keyboard.type("gemini", { delay: 130 });
      await hold(1000);
      await press(page, picker.getByRole("button", { name: "Favorite Gemini 3 Pro" }));
      await hold(2000);
    },
  },

  review: {
    out: "feature-review.gif",
    ready: (page) => sessionRow(page, SESSIONS.auth).waitFor(),
    async setup(page) {
      await openSession(page, SESSIONS.auth);
    },
    async run(page) {
      await hold(1000);
      await press(page, page.getByTitle("View changed files"));
      const added = page.locator(".diff-line--add .diff-line-number");
      await added.first().waitFor();
      await hold(1200);
      await press(page, added.first());
      await glide(page, added.nth(2));
      await page.keyboard.down("Shift");
      await added.nth(2).click();
      await page.keyboard.up("Shift");
      const note = page.getByLabel("Comment", { exact: true });
      await note.waitFor();
      await hold(500);
      await page.keyboard.type("Should an expired token log the user out?", { delay: 45 });
      await hold(500);
      await press(page, page.getByRole("button", { name: "Add comment" }));
      const review = page.locator(".diff-review");
      await review.waitFor();
      await review.scrollIntoViewIfNeeded();
      await hold(2600);
    },
  },

  projects: {
    out: "feature-projects.gif",
    ready: (page) => sessionRow(page, SESSIONS.retry).waitFor(),
    async setup(page) {
      await openSession(page, SESSIONS.retry);
    },
    async run(page) {
      const grouping = sidebar(page).locator(".session-grouping");
      await hold(1500);
      await press(page, grouping.getByRole("radio", { name: "Status" }));
      await hold(2600);
      await press(page, grouping.getByRole("radio", { name: "Project" }));
      await hold(1500);
    },
  },
};

/** Screenshots the page back to back until stopped; each frame keeps its capture time. */
function startCapture(page, dir) {
  const frames = [];
  let running = true;
  const begin = performance.now();
  const loop = (async () => {
    for (let index = 0; running; index += 1) {
      const at = performance.now() - begin;
      const file = join(dir, `${String(index).padStart(5, "0")}.png`);
      await page.screenshot({ path: file, type: "png" });
      frames.push({ file, at });
    }
  })();
  return async () => {
    running = false;
    await loop;
    return { frames, length: performance.now() - begin };
  };
}

function writeFrameList({ frames, length }, listPath) {
  const lines = frames.map((frame, index) => {
    const next = frames[index + 1]?.at ?? length;
    return `file '${frame.file}'\nduration ${((next - frame.at) / 1000).toFixed(4)}`;
  });
  lines.push(`file '${frames.at(-1).file}'`);
  writeFileSync(listPath, lines.join("\n"));
}

function runFfmpeg(args) {
  const result = spawnSync(ffmpeg, ["-y", "-loglevel", "error", ...args], { stdio: "inherit" });
  if (result.status !== 0) throw new Error("ffmpeg failed: " + args.join(" "));
}

function encodeGif(capture, gifPath, listPath, { width = GIF_WIDTH, fps = GIF_FPS, colors = 96 } = {}) {
  writeFrameList(capture, listPath);
  const scale = `fps=${fps},scale=${width}:-1:flags=lanczos`;
  runFfmpeg([
    "-f", "concat", "-safe", "0", "-i", listPath,
    "-vf", `${scale},split[a][b];[a]palettegen=max_colors=${colors}:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
    "-loop", "0", gifPath,
  ]);
}

function encodeMp4(capture, mp4Path, listPath) {
  writeFrameList(capture, listPath);
  runFfmpeg([
    "-f", "concat", "-safe", "0", "-i", listPath,
    "-vf", `fps=30,scale=${DEMO_WIDTH}:${DEMO_HEIGHT}:flags=lanczos`,
    "-c:v", "libx264", "-preset", "veryslow", "-crf", "20", "-pix_fmt", "yuv420p",
    "-movflags", "+faststart", mp4Path,
  ]);
}

const size = (file) => (statSync(file).size / 1024).toFixed(0) + " KB";

async function newPage(browser, { query, theme = "dark", agents = false, width = WIDTH, height = HEIGHT, scale = SCALE, pointerRing = true }) {
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: scale,
    colorScheme: theme,
  });
  await context.addInitScript(pageSetup, { language: "en", theme, agents: agents ? AGENTS : null });
  if (pointerRing) await context.addInitScript(POINTER);
  const page = await context.newPage();
  pointer.x = width / 2;
  pointer.y = height / 2;
  await page.goto(`http://localhost:${port}/?backend=mock&${query}`);
  return { context, page };
}

async function recordFeature(browser, name) {
  const scene = scenes[name];
  const dir = join(workDir, name);
  mkdirSync(dir, { recursive: true });
  const { context, page } = await newPage(browser, { query: scene.query ?? "sample=readme", agents: scene.agents });
  await scene.ready(page);
  await scene.setup(page);
  await hold(500);
  const stop = startCapture(page, dir);
  let capture;
  try {
    await scene.run(page);
    await hold(200);
  } finally {
    capture = await stop();
  }
  await context.close();
  const gif = join(outDir, scene.out);
  encodeGif(capture, gif, join(dir, "frames.txt"));
  const fps = (capture.frames.length / (capture.length / 1000)).toFixed(1);
  console.log(`${scene.out}  ${size(gif)}  ${(capture.length / 1000).toFixed(1)} s  captured ${fps} fps`);
}

/** Types the scripted request into the retry session and returns once it runs. */
async function sendDemoRequest(page) {
  await openSession(page, SESSIONS.retry);
  await hold(1800);
  await composer(page).click();
  await page.keyboard.type(DEMO_REQUEST, { delay: 45 });
  await hold(500);
  await page.keyboard.press("Enter");
}

const questionCard = (page) => page.locator("text=Which retry policy should RouterClient use?").last();

async function answerDemoQuestion(page) {
  await questionCard(page).waitFor({ timeout: 30_000 });
  await hold(2600);
  await page.keyboard.press("1");
  await hold(900);
  await page.keyboard.press("Enter");
}

async function finishedDemo(page) {
  await page.getByText("3/3").first().waitFor({ timeout: 40_000 });
  await page.locator(".goal-row, [class*=goal]").first().waitFor();
}

async function recordDemo(browser) {
  const dir = join(workDir, "demo");
  mkdirSync(dir, { recursive: true });
  const { context, page } = await newPage(browser, {
    query: "sample=readme",
    width: DEMO_WIDTH,
    height: DEMO_HEIGHT,
    pointerRing: false,
  });
  await sessionRow(page, SESSIONS.retry).waitFor();
  await hold(500);
  const stop = startCapture(page, dir);
  let capture;
  try {
    await sendDemoRequest(page);
    await answerDemoQuestion(page);
    await finishedDemo(page);
    await hold(3200);
  } finally {
    capture = await stop();
  }
  await context.close();
  const gif = join(outDir, "demo.gif");
  const mp4 = join(outDir, "demo.mp4");
  encodeGif(capture, gif, join(dir, "frames.txt"), { width: 1100, fps: 12, colors: 128 });
  encodeMp4(capture, mp4, join(dir, "frames.txt"));
  const fps = (capture.frames.length / (capture.length / 1000)).toFixed(1);
  console.log(`demo.gif ${size(gif)}, demo.mp4 ${size(mp4)}  ${(capture.length / 1000).toFixed(1)} s  captured ${fps} fps`);
}

/** A still of the scripted request at the point `until` names, at 1.25x. */
async function recordStill(browser, { out, theme, until }) {
  const { context, page } = await newPage(browser, {
    query: "sample=readme",
    theme,
    width: DEMO_WIDTH,
    height: DEMO_HEIGHT,
    scale: 1.25,
    pointerRing: false,
  });
  await sessionRow(page, SESSIONS.retry).waitFor();
  await sendDemoRequest(page);
  if (until === "question") {
    await questionCard(page).waitFor({ timeout: 30_000 });
    await hold(1500);
  } else {
    await answerDemoQuestion(page);
    await finishedDemo(page);
    await hold(1800);
    // open the turn's work log and the goal's tasks, so the still shows what the run did
    await page.getByText("Work log", { exact: true }).click();
    await hold(600);
    await page.getByText("Make the router client resilient", { exact: true }).click();
    await hold(1200);
  }
  await page.mouse.move(DEMO_WIDTH / 2, DEMO_HEIGHT - 4);
  const file = join(outDir, out);
  await page.screenshot({ path: file, type: "png" });
  await context.close();
  console.log(`${out}  ${size(file)}`);
}

const stills = {
  "question-dark": { out: "question-dark.png", theme: "dark", until: "question" },
  "done-light": { out: "done-light.png", theme: "light", until: "done" },
};

const wanted = process.argv.slice(2);
const names = wanted.length > 0 ? wanted : [...Object.keys(scenes), "demo", ...Object.keys(stills)];
for (const name of names)
  if (!scenes[name] && !stills[name] && name !== "demo") throw new Error(`unknown scene: ${name}`);

mkdirSync(outDir, { recursive: true });
rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROME });
try {
  for (const name of names) {
    if (name === "demo") await recordDemo(browser);
    else if (stills[name]) await recordStill(browser, stills[name]);
    else await recordFeature(browser, name);
  }
} finally {
  await browser.close();
}

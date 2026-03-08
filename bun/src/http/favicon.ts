import type { Elysia } from "elysia";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const BRAND_CACHE_CONTROL = "public, max-age=86400";
const ASSET_DIR = join(import.meta.dir, "assets");
const SVG_PATH = join(import.meta.dir, "..", "..", "music.svg");
const SVG_FALLBACK_PATH = join(ASSET_DIR, "music-key.svg");
const PNG_180_PATH = join(ASSET_DIR, "apple-touch-icon.png");
const PNG_192_PATH = join(ASSET_DIR, "icon-192.png");
const PNG_512_PATH = join(ASSET_DIR, "icon-512.png");

const BRAND_ASSET_PATHS = new Set([
  "/favicon.svg",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-512.png",
  "/site.webmanifest",
]);

const readBrandSvg = (): string => {
  try {
    return readFileSync(SVG_PATH, "utf8");
  } catch {
    return readFileSync(SVG_FALLBACK_PATH, "utf8");
  }
};

export const MUSIC_KEY_FAVICON_SVG = readBrandSvg();

const inlineBrandSvg = MUSIC_KEY_FAVICON_SVG.replace(/^<\?xml[^>]*>\s*/, "").replace(
  "<svg ",
  '<svg aria-hidden="true" focusable="false" ',
);

const webManifest = JSON.stringify(
  {
    name: "Symphony",
    short_name: "Symphony",
    description: "Agent orchestration for Linear workflows.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#0a1018",
    theme_color: "#0d1520",
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any maskable",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any maskable",
      },
    ],
  },
  null,
  2,
);

export const registerBrandRoutes = (app: Elysia): void => {
  app.get("/favicon.svg", () => musicKeyFaviconResponse());
  app.get("/apple-touch-icon.png", () => pngResponse(PNG_180_PATH));
  app.get("/icon-192.png", () => pngResponse(PNG_192_PATH));
  app.get("/icon-512.png", () => pngResponse(PNG_512_PATH));
  app.get("/site.webmanifest", () => webManifestResponse());
};

export const isBrandAssetPath = (path: string): boolean => {
  return BRAND_ASSET_PATHS.has(path);
};

export const renderBrandHead = (title: string): string => {
  return `
        <title>${title}</title>
        <meta name="theme-color" content="#0d1520" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-title" content="Symphony" />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
        <link rel="manifest" href="/site.webmanifest" />`;
};

export const renderBrandMark = (className: string): string => {
  return inlineBrandSvg.replace("<svg ", `<svg class="${className}" `);
};

export const musicKeyFaviconResponse = (): Response => {
  return new Response(MUSIC_KEY_FAVICON_SVG, {
    headers: {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": BRAND_CACHE_CONTROL,
    },
  });
};

const pngResponse = (path: string): Response => {
  return new Response(Bun.file(path), {
    headers: {
      "content-type": "image/png",
      "cache-control": BRAND_CACHE_CONTROL,
    },
  });
};

const webManifestResponse = (): Response => {
  return new Response(webManifest, {
    headers: {
      "content-type": "application/manifest+json; charset=utf-8",
      "cache-control": BRAND_CACHE_CONTROL,
    },
  });
};

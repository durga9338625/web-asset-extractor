import { Router, type IRouter } from "express";
import {
  DownloadImagesBody,
  ScanImagesBody,
  ScanImagesResponse,
} from "@workspace/api-zod";

type ImageSource = "image" | "srcset" | "lazy" | "social" | "background";
type ImageAsset = {
  url: string;
  filename: string;
  source: ImageSource;
  width: number | null;
  height: number | null;
  alt: string | null;
};

const router: IRouter = Router();
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

function safePublicUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    const hostname = url.hostname.toLowerCase();
    if (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "127.0.0.1" ||
      hostname === "::1" ||
      hostname.startsWith("10.") ||
      hostname.startsWith("192.168.") ||
      hostname.startsWith("169.254.") ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function attr(tag: string, name: string): string | null {
  const match = tag.match(
    new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"),
  );
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function resolveImageUrl(raw: string, pageUrl: URL): string | null {
  const value = raw.trim().replace(/^['"]|['"]$/g, "");
  if (!value || value.startsWith("data:") || value.startsWith("blob:")) {
    return null;
  }
  try {
    const resolved = new URL(value, pageUrl);
    if (!["http:", "https:"].includes(resolved.protocol)) return null;
    resolved.hash = "";
    return resolved.toString();
  } catch {
    return null;
  }
}

function parseSrcset(value: string, pageUrl: URL): string[] {
  return value
    .split(",")
    .map((candidate) => candidate.trim().split(/\s+/)[0])
    .map((candidate) => resolveImageUrl(candidate, pageUrl))
    .filter((candidate): candidate is string => Boolean(candidate));
}

function filenameFor(url: string, index: number): string {
  try {
    const pathname = new URL(url).pathname;
    const last = decodeURIComponent(pathname.split("/").filter(Boolean).pop() ?? "");
    const cleaned = last.replace(/[^a-z0-9._-]/gi, "-");
    if (cleaned && cleaned !== "." && cleaned !== "..") return cleaned;
  } catch {
    // Use a stable fallback below.
  }
  return `image-${String(index + 1).padStart(3, "0")}.jpg`;
}

function dimensions(tag: string): [number | null, number | null] {
  const width = Number.parseInt(attr(tag, "width") ?? "", 10);
  const height = Number.parseInt(attr(tag, "height") ?? "", 10);
  return [Number.isFinite(width) ? width : null, Number.isFinite(height) ? height : null];
}

function canonicalAssetKey(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    url.hostname = url.hostname.toLowerCase();
    url.pathname = url.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
    url.pathname = url.pathname
      .split("/")
      .filter(
        (segment) =>
          !/^_?\d{2,5}x(?:\d{2,5}|auto)(?:[_-].*)?$/i.test(segment) &&
          !/^_?(?:\d{2,5}w|(?:thumb|thumbnail|small|medium|large|original))$/i.test(segment),
      )
      .join("/") || "/";
    url.pathname = url.pathname.replace(
      /(?:[-_]\d{2,5}x\d{2,5}|[-_]\d{2,5}w|-scaled)(?=\.[a-z0-9]+$)/i,
      "",
    );

    const ignoredParams = /^(utm_[a-z0-9_]+|fbclid|gclid|mc_cid|mc_eid|ver|version|cachebust|cache_bust|cb)$/i;
    const variantParams = /^(w|width|h|height|q|quality|dpr|fit|crop|format|fm|auto|resize|resizes|size)$/i;
    const retained = [...url.searchParams.entries()]
      .filter(([name]) => !ignoredParams.test(name))
      .filter(([name]) => !variantParams.test(name))
      .sort(([a], [b]) => a.localeCompare(b));

    url.search = "";
    for (const [name, parameter] of retained) url.searchParams.append(name, parameter);
    return url.toString().toLowerCase();
  } catch {
    return value.trim().toLowerCase();
  }
}

function sourcePriority(source: ImageSource): number {
  return { image: 5, lazy: 4, srcset: 3, social: 2, background: 1 }[source];
}

function discoverImages(html: string, pageUrl: URL): ImageAsset[] {
  const candidates: Array<{
    raw: string;
    source: ImageSource;
    tag: string;
  }> = [];
  const add = (raw: string | null, source: ImageSource, tag: string) => {
    if (!raw) return;
    if (source === "srcset") {
      for (const item of parseSrcset(raw, pageUrl)) candidates.push({ raw: item, source, tag });
      return;
    }
    const resolved = resolveImageUrl(raw, pageUrl);
    if (resolved) candidates.push({ raw: resolved, source, tag });
  };

  for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    add(attr(tag, "src"), "image", tag);
    add(attr(tag, "srcset"), "srcset", tag);
    add(attr(tag, "data-src"), "lazy", tag);
    add(attr(tag, "data-lazy-src"), "lazy", tag);
    add(attr(tag, "data-original"), "lazy", tag);
    add(attr(tag, "data-lazy"), "lazy", tag);
    add(attr(tag, "data-srcset"), "lazy", tag);
  }
  for (const match of html.matchAll(/<source\b[^>]*>/gi)) {
    const tag = match[0];
    add(attr(tag, "src"), "image", tag);
    add(attr(tag, "srcset"), "srcset", tag);
    add(attr(tag, "data-srcset"), "lazy", tag);
  }
  for (const match of html.matchAll(
    /<meta\b[^>]*(?:property|name)\s*=\s*["'](?:og:image|twitter:image|twitter:image:src)["'][^>]*>/gi,
  )) {
    add(attr(match[0], "content"), "social", match[0]);
  }
  for (const match of html.matchAll(/background(?:-image)?\s*:\s*url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
    add(match[2], "background", match[0]);
  }
  for (const match of html.matchAll(/style\s*=\s*["'][^"']*url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
    add(match[2], "background", match[0]);
  }

  const assetsByKey = new Map<string, ImageAsset>();
  for (const candidate of candidates) {
    const [width, height] = dimensions(candidate.tag);
    const nextAsset: ImageAsset = {
      url: candidate.raw,
      filename: filenameFor(candidate.raw, assetsByKey.size),
      source: candidate.source,
      width,
      height,
      alt: attr(candidate.tag, "alt"),
    };
    const key = canonicalAssetKey(candidate.raw);
    const existing = assetsByKey.get(key);
    if (
      !existing ||
      sourcePriority(nextAsset.source) > sourcePriority(existing.source) ||
      (nextAsset.width !== null && nextAsset.height !== null && existing.width === null)
    ) {
      assetsByKey.set(key, nextAsset);
    }
  }
  return [...assetsByKey.values()];
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent": "ImageHarvester/1.0 (+public-page-scanner)",
        accept: "text/html,image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        ...init?.headers,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function isRobotsAllowed(pageUrl: URL): Promise<boolean> {
  try {
    const robotsUrl = new URL("/robots.txt", pageUrl);
    const response = await fetchWithTimeout(robotsUrl.toString(), {
      headers: { accept: "text/plain,*/*;q=0.5" },
    });
    if (!response.ok) return true;
    const text = (await response.text()).slice(0, 200_000);
    let applies = false;
    let blocked = false;
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.split("#")[0].trim();
      if (!line) continue;
      const separator = line.indexOf(":");
      if (separator < 0) continue;
      const key = line.slice(0, separator).trim().toLowerCase();
      const value = line.slice(separator + 1).trim();
      if (key === "user-agent") {
        applies = value === "*" || value.toLowerCase() === "imageharvester";
        blocked = false;
      } else if (applies && key === "disallow" && value) {
        try {
          if (pageUrl.pathname.startsWith(new URL(value, pageUrl).pathname)) blocked = true;
        } catch {
          if (pageUrl.pathname.startsWith(value)) blocked = true;
        }
      }
    }
    return !blocked;
  } catch {
    return true;
  }
}

function extractInternalLinks(html: string, pageUrl: URL, siteOrigin: string): URL[] {
  const links: URL[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/<a\b[^>]*>/gi)) {
    const rawHref = attr(match[0], "href");
    if (!rawHref || /^(?:mailto:|tel:|javascript:|#)/i.test(rawHref)) continue;
    try {
      const link = new URL(rawHref, pageUrl);
      if (!["http:", "https:"].includes(link.protocol) || link.origin !== siteOrigin) continue;
      if (/\.(?:avif|bmp|css|gif|ico|jpe?g|js|json|mp[34]|pdf|png|svg|txt|webp|xml|zip)(?:$|\/)/i.test(link.pathname)) continue;
      link.hash = "";
      link.search = "";
      const key = link.toString();
      if (!seen.has(key)) {
        seen.add(key);
        links.push(link);
      }
    } catch {
      // Ignore malformed or unsupported links.
    }
  }
  return links;
}

function addAssetToMap(assets: Map<string, ImageAsset>, asset: ImageAsset): void {
  const key = canonicalAssetKey(asset.url);
  const existing = assets.get(key);
  if (
    !existing ||
    sourcePriority(asset.source) > sourcePriority(existing.source) ||
    (asset.width !== null && asset.height !== null && existing.width === null)
  ) {
    assets.set(key, asset);
  }
}

router.post("/images/scan", async (req, res): Promise<void> => {
  const parsed = ScanImagesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Enter a valid public webpage URL." });
    return;
  }
  const pageUrl = safePublicUrl(parsed.data.url);
  if (!pageUrl) {
    res.status(400).json({ error: "Only public http:// and https:// URLs can be scanned." });
    return;
  }

  try {
    const scope = parsed.data.scope ?? "page";
    const maxPages = scope === "site" ? (parsed.data.maxPages ?? 20) : 1;
    const queue: URL[] = [pageUrl];
    const visited = new Set<string>();
    const assets = new Map<string, ImageAsset>();
    const warnings = new Set<string>();
    let pageTitle = "";
    let pagesScanned = 0;
    let rawCandidateCount = 0;

    while (queue.length > 0 && pagesScanned < maxPages) {
      const currentUrl = queue.shift()!;
      const currentKey = currentUrl.toString();
      if (visited.has(currentKey)) continue;
      visited.add(currentKey);

      if (!(await isRobotsAllowed(currentUrl))) {
        warnings.add(`Skipped ${currentUrl.pathname || "/"} because its robots.txt rules disallow scanning.`);
        continue;
      }

      let response: Response;
      try {
        response = await fetchWithTimeout(currentUrl.toString());
      } catch (error) {
        if (currentKey === pageUrl.toString()) throw error;
        warnings.add(`Could not fetch ${currentUrl.pathname || "/"}; continuing with the other pages.`);
        continue;
      }
      if (!response.ok) {
        if (currentKey === pageUrl.toString()) {
          res.status(422).json({
            error: `The page returned ${response.status}. It may require authentication or block automated requests.`,
          });
          return;
        }
        warnings.add(`Skipped ${currentUrl.pathname || "/"} because it returned ${response.status}.`);
        continue;
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("text/html")) {
        if (currentKey === pageUrl.toString()) {
          res.status(422).json({ error: "That URL does not return an HTML webpage." });
          return;
        }
        continue;
      }

      const html = (await response.text()).slice(0, MAX_HTML_BYTES);
      pagesScanned += 1;
      if (!pageTitle) {
        pageTitle =
          html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s+/g, " ").trim() ??
          "";
      }
      rawCandidateCount += [
        ...(html.match(/<img\b[^>]*>/gi) ?? []),
        ...(html.match(/<source\b[^>]*>/gi) ?? []),
        ...(html.match(/(?:og:image|twitter:image|twitter:image:src)/gi) ?? []),
        ...(html.match(/background(?:-image)?\s*:\s*url/gi) ?? []),
      ].length;
      for (const asset of discoverImages(html, currentUrl)) addAssetToMap(assets, asset);
      if (html.length >= MAX_HTML_BYTES) {
        warnings.add(`The page ${currentUrl.pathname || "/"} was truncated during scanning.`);
      }

      if (scope === "site") {
        for (const link of extractInternalLinks(html, currentUrl, pageUrl.origin)) {
          const linkKey = link.toString();
          if (!visited.has(linkKey) && !queue.some((queued) => queued.toString() === linkKey)) {
            queue.push(link);
          }
        }
      }
    }

    if (scope === "site" && queue.length > 0) {
      warnings.add(`The crawl limit of ${maxPages} pages was reached. Increase the limit to scan more.`);
    }
    if (assets.size === 0) {
      warnings.add("No image URLs were found in the scanned HTML. Images rendered only by JavaScript may not be discoverable.");
    }
    if (rawCandidateCount > assets.size) {
      warnings.add("Repeated image references and resized URL variants were merged.");
    }
    const result = {
      pageUrl: pageUrl.toString(),
      pageTitle: pageTitle || pageUrl.hostname,
      images: [...assets.values()],
      warnings: [...warnings],
      pagesScanned,
      pagesDiscovered: visited.size + queue.length,
    };
    if (pagesScanned === 0) {
      res.status(422).json({ error: "No accessible HTML pages were found on that site." });
      return;
    }
    res.json(ScanImagesResponse.parse(result));
  } catch (error) {
    const message =
      error instanceof Error && error.name === "AbortError"
        ? "The page took too long to respond. Try again or use a simpler public URL."
        : "The page could not be fetched. CORS, robots rules, hotlink protection, authentication, or network restrictions may be blocking access.";
    req.log.warn({ error: message }, "Image scan failed");
    res.status(422).json({ error: message });
  }
});

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipFiles(files: Array<{ name: string; data: Buffer }>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name.slice(0, 180), "utf8");
    const crc = crc32(file.data);
    const header = Buffer.alloc(30 + name.length);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(file.data.length, 18);
    header.writeUInt32LE(file.data.length, 22);
    header.writeUInt16LE(name.length, 26);
    name.copy(header, 30);
    local.push(header, file.data);

    const entry = Buffer.alloc(46 + name.length);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0, 8);
    entry.writeUInt16LE(0, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(0, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(file.data.length, 20);
    entry.writeUInt32LE(file.data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt16LE(0, 30);
    entry.writeUInt16LE(0, 32);
    entry.writeUInt16LE(0, 34);
    entry.writeUInt16LE(0, 36);
    entry.writeUInt32LE(0, 38);
    entry.writeUInt32LE(offset, 42);
    name.copy(entry, 46);
    central.push(entry);
    offset += header.length + file.data.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBuffer, end]);
}

router.get("/images/file", async (req, res): Promise<void> => {
  const rawUrl = typeof req.query.url === "string" ? req.query.url : "";
  const publicUrl = safePublicUrl(rawUrl);
  if (!publicUrl) {
    res.status(400).json({ error: "Enter a valid public image URL." });
    return;
  }

  try {
    const response = await fetchWithTimeout(publicUrl.toString(), {
      headers: { accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.5" },
    });
    if (!response.ok) {
      res.status(422).json({ error: `The image source returned ${response.status}.` });
      return;
    }
    const contentType = response.headers.get("content-type") ?? "application/octet-stream";
    if (contentType.toLowerCase().includes("text/html")) {
      res.status(422).json({ error: "The image source returned HTML instead of an image." });
      return;
    }
    const data = Buffer.from(await response.arrayBuffer());
    if (!data.length || data.length > 20 * 1024 * 1024) {
      res.status(422).json({ error: "The image is empty or larger than 20 MB." });
      return;
    }

    const filename = filenameFor(publicUrl.toString(), 0);
    const shouldDownload = req.query.download === "1" || req.query.download === "true";
    res.setHeader("Content-Type", contentType);
    res.setHeader("Content-Length", data.length);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader(
      "Content-Disposition",
      `${shouldDownload ? "attachment" : "inline"}; filename="${filename}"`,
    );
    res.send(data);
  } catch (error) {
    const message =
      error instanceof Error && error.name === "AbortError"
        ? "The image source took too long to respond."
        : "The image source blocked server-side fetching.";
    res.status(422).json({ error: message });
  }
});

router.post("/images/download", async (req, res): Promise<void> => {
  const parsed = DownloadImagesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Select at least one image to download." });
    return;
  }
  const files: Array<{ name: string; data: Buffer }> = [];
  const usedNames = new Set<string>();
  for (const [index, rawUrl] of parsed.data.urls.entries()) {
    const publicUrl = safePublicUrl(rawUrl);
    if (!publicUrl) continue;
    try {
      const response = await fetchWithTimeout(publicUrl.toString(), { headers: { accept: "image/*,*/*;q=0.5" } });
      if (!response.ok) continue;
      const data = Buffer.from(await response.arrayBuffer());
      if (!data.length || data.length > 20 * 1024 * 1024) continue;
      let name = filenameFor(publicUrl.toString(), index);
      const base = name.replace(/(\.[a-z0-9]+)$/i, "");
      const ext = name.match(/(\.[a-z0-9]+)$/i)?.[1] ?? ".jpg";
      let suffix = 1;
      while (usedNames.has(name)) name = `${base}-${suffix++}${ext}`;
      usedNames.add(name);
      files.push({ name, data });
    } catch {
      // A ZIP is best effort: inaccessible individual assets are skipped.
    }
  }
  if (!files.length) {
    res.status(422).json({ error: "None of the selected images could be fetched." });
    return;
  }
  const archive = zipFiles(files);
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", 'attachment; filename="image-harvester.zip"');
  res.setHeader("Content-Length", archive.length);
  res.send(archive);
});

export default router;
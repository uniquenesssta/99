import { Buffer } from "node:buffer";
import { promises as fsp } from "node:fs";
import { extname } from "node:path";
import { TextDecoder } from "node:util";
import type {
  AuthorizeFontRead,
  FontPathAuthorizationFailureReason,
} from "../path/fontPathAuthorizationRuntime";

const FONT_PROTOCOL_PREFIX = "hfm-font://local/";
const BASE64URL_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/;
const ENCODED_SEQUENCE_PATTERN = /%[0-9A-Fa-f]{2}/;
const CONTROL_CHARACTER_PATTERN = /[\x00-\x1F\x7F]/;

type FontProtocolRuntimeOptions = {
  authorizeFontRead: AuthorizeFontRead;
  appendLog: (message: string) => void;
};

type FontProtocolRequest = {
  url: string;
};

function fontContentType(filePath: string): string {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".otf" || extension === ".otc") return "font/otf";
  if (extension === ".ttc") return "font/collection";
  return "font/ttf";
}

function decodeBase64UrlPath(token: string): string | null {
  if (!BASE64URL_TOKEN_PATTERN.test(token)) return null;
  try {
    const bytes = Buffer.from(token, "base64url");
    if (!bytes.length || bytes.toString("base64url") !== token) return null;
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function decodeFontProtocolPath(rawToken: string): string | null {
  if (!rawToken) return null;
  let decodedPath: string | null = null;
  if (rawToken.startsWith("b64/")) {
    decodedPath = decodeBase64UrlPath(rawToken.slice(4));
  } else {
    try {
      decodedPath = decodeURIComponent(rawToken);
    } catch {
      return null;
    }
    if (ENCODED_SEQUENCE_PATTERN.test(decodedPath)) return null;
  }
  if (!decodedPath || CONTROL_CHARACTER_PATTERN.test(decodedPath)) return null;
  return decodedPath;
}

function denialStatus(reason: FontPathAuthorizationFailureReason): number {
  if (reason === "invalid-path") return 400;
  if (reason === "file-too-large") return 413;
  if (reason === "path-unavailable" || reason === "not-regular-file") {
    return 404;
  }
  return 403;
}

function textResponse(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

export function createFontProtocolRuntime(options: FontProtocolRuntimeOptions) {
  async function handleRequest(request: FontProtocolRequest): Promise<Response> {
    if (!request.url.startsWith(FONT_PROTOCOL_PREFIX)) {
      return textResponse("Bad font request", 400);
    }

    const filePath = decodeFontProtocolPath(
      request.url.slice(FONT_PROTOCOL_PREFIX.length),
    );
    if (!filePath) {
      options.appendLog("font protocol rejected malformed path token");
      return textResponse("Bad font request path", 400);
    }

    const authorization = await options.authorizeFontRead(filePath);
    if (!authorization.ok) {
      const status = denialStatus(authorization.reason);
      options.appendLog(
        `font protocol denied: reason=${authorization.reason}, status=${status}`,
      );
      return textResponse("Font request denied", status);
    }

    try {
      const data = await fsp.readFile(authorization.value.ioPath);
      const body = new Uint8Array(
        data.buffer,
        data.byteOffset,
        data.byteLength,
      );
      return new Response(body as unknown as BodyInit, {
        status: 200,
        headers: {
          "Content-Type": fontContentType(authorization.value.ioPath),
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store",
        },
      });
    } catch (error) {
      options.appendLog(
        `font protocol authorized read failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return textResponse("Font file read failed", 500);
    }
  }

  return { handleRequest };
}

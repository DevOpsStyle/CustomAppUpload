import assert from "node:assert/strict";
import { test } from "node:test";
import { AppError } from "../server/errors.js";
import { mediaInfo, safeUploadName, verifyMediaHeader } from "../server/media.js";
import { relativePath } from "../server/paths.js";
import { parseRange } from "../server/ranges.js";
import { jpeg } from "./fixtures.js";

test("relative paths stay within the configured root", () => {
  assert.equal(relativePath(""), "");
  assert.equal(relativePath("Piano 1/Fotografie"), "Piano 1/Fotografie");
  for (const input of ["../private", "demo/../../private", "/Files", "a\\..\\b", "%2e%2e/a", "a//b", "a/.", ".upload-secret.part", "a/.upload-secret", "a\u0000b", "a?b", "a#b", [], {}]) {
    assert.throws(() => relativePath(input), AppError);
  }
  assert.throws(() => relativePath("", false), AppError);
});

test("media names are sanitized and unsupported active content is rejected", () => {
  assert.equal(safeUploadName('foto: piano 1.JPG'), "foto_ piano 1.jpg");
  assert.equal(mediaInfo("video.mov").kind, "video");
  assert.equal(mediaInfo("image.svg").kind, "other");
  for (const input of ["../photo.jpg", "x\\photo.jpg", "test.html", "test.svg", "test.exe", "test.__proto__", "test.constructor", "test.toString", "jpg", ".jpg", ""]) {
    assert.throws(() => safeUploadName(input), AppError);
  }
});

test("verifies media magic bytes instead of trusting filenames or MIME from the browser", async () => {
  await verifyMediaHeader("photo.jpg", jpeg());
  await assert.rejects(verifyMediaHeader("video.mp4", jpeg()), { code: "INVALID_MEDIA" });
  await assert.rejects(verifyMediaHeader("image.jpg", Buffer.from("<script>alert(1)</script>")), { code: "INVALID_MEDIA" });
  const mp4 = Buffer.alloc(64);
  mp4.writeUInt32BE(24, 0);
  mp4.write("ftyp", 4);
  mp4.write("mp42", 8);
  await verifyMediaHeader("video.mp4", mp4);
});

test("supports ordinary, open-ended and suffix byte ranges for mobile video playback", () => {
  assert.equal(parseRange(undefined, 100), undefined);
  assert.deepEqual(parseRange("bytes=0-9", 100), { offset: 0, count: 10 });
  assert.deepEqual(parseRange("bytes=90-", 100), { offset: 90, count: 10 });
  assert.deepEqual(parseRange("bytes=-10", 100), { offset: 90, count: 10 });
  assert.deepEqual(parseRange("bytes=-1000", 100), { offset: 0, count: 100 });
  assert.deepEqual(parseRange("bytes=90-150", 100), { offset: 90, count: 10 });
  for (const input of ["bytes=100-", "bytes=4-2", "bytes=-0", "bytes=-", "bytes=0-1,5-6", "bytes=99999999999999999999-", "items=0-4"]) {
    assert.throws(() => parseRange(input, 100), { status: 416 });
  }
  assert.throws(() => parseRange("bytes=0-", 0), { status: 416 });
});

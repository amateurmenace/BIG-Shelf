/**
 * Tests for the client-safe big-equipment helpers — chiefly the video-embed
 * URL converter, which gates what the member info page will iframe (only
 * YouTube/Vimeo; everything else must render as a plain link).
 */
import { describe, expect, it } from "vitest";
import { videoEmbedUrl } from "./shared";

describe("videoEmbedUrl", () => {
  it("converts youtube watch URLs", () => {
    expect(videoEmbedUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"
    );
  });

  it("converts youtu.be short URLs", () => {
    expect(videoEmbedUrl("https://youtu.be/dQw4w9WgXcQ?t=10")).toBe(
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"
    );
  });

  it("converts youtube shorts and embed URLs", () => {
    expect(videoEmbedUrl("https://youtube.com/shorts/dQw4w9WgXcQ")).toBe(
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"
    );
    expect(videoEmbedUrl("https://www.youtube.com/embed/dQw4w9WgXcQ")).toBe(
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"
    );
  });

  it("converts vimeo URLs", () => {
    expect(videoEmbedUrl("https://vimeo.com/76979871")).toBe(
      "https://player.vimeo.com/video/76979871"
    );
    expect(videoEmbedUrl("https://player.vimeo.com/video/76979871")).toBe(
      "https://player.vimeo.com/video/76979871"
    );
  });

  it("rejects non-video and lookalike hosts (no arbitrary iframes)", () => {
    expect(videoEmbedUrl("https://example.com/watch?v=dQw4w9WgXcQ")).toBeNull();
    expect(
      videoEmbedUrl("https://evilyoutube.com/watch?v=dQw4w9WgXcQ")
    ).toBeNull();
    expect(
      videoEmbedUrl("https://youtube.com.evil.io/watch?v=dQw4w9WgXcQ")
    ).toBeNull();
    expect(
      videoEmbedUrl("https://drive.google.com/file/d/abc/view")
    ).toBeNull();
  });

  it("rejects malformed values", () => {
    expect(videoEmbedUrl("not a url")).toBeNull();
    expect(videoEmbedUrl("javascript:alert(1)")).toBeNull();
    expect(videoEmbedUrl("https://youtube.com/watch?v=short")).toBeNull();
  });
});

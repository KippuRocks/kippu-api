import { describe, expect, it } from "vitest";
import {
  DEFAULT_METADATA_PUBLIC_URL,
  loadMetadataConfig,
  loadMetadataEdgeConfig,
  MetadataConfigError,
} from "../../src/metadata/config.js";

const bucket = { KIPPU_METADATA_S3_BUCKET: "kippu-metadata" };

describe("metadata configuration", () => {
  it("AD-22: documents are addressed at meta.kippu.rocks unless configured otherwise", () => {
    expect(DEFAULT_METADATA_PUBLIC_URL).toBe("https://meta.kippu.rocks");
    expect(loadMetadataConfig(bucket)).toEqual({
      publicUrl: "https://meta.kippu.rocks",
      storage: { bucket: "kippu-metadata", region: "us-east-1", forcePathStyle: false },
    });
    expect(
      loadMetadataConfig({ ...bucket, KIPPU_METADATA_PUBLIC_URL: "https://meta.staging.example" })
        .publicUrl,
    ).toBe("https://meta.staging.example");
  });

  it("reads an S3-compatible endpoint, path-style addressing and static credentials", () => {
    expect(
      loadMetadataConfig({
        ...bucket,
        KIPPU_METADATA_S3_ENDPOINT: "http://127.0.0.1:9000",
        KIPPU_METADATA_S3_REGION: "eu-west-1",
        KIPPU_METADATA_S3_FORCE_PATH_STYLE: "true",
        KIPPU_METADATA_S3_ACCESS_KEY_ID: "local",
        KIPPU_METADATA_S3_SECRET_ACCESS_KEY: "local-secret",
      }).storage,
    ).toEqual({
      bucket: "kippu-metadata",
      region: "eu-west-1",
      endpoint: "http://127.0.0.1:9000",
      forcePathStyle: true,
      credentials: { accessKeyId: "local", secretAccessKey: "local-secret" },
    });
  });

  it("refuses a public URL that is not an https origin", () => {
    for (const value of [
      "meta.kippu.rocks",
      "http://meta.kippu.rocks",
      "https://meta.kippu.rocks/",
      "https://meta.kippu.rocks/v0",
    ]) {
      expect(() => loadMetadataConfig({ ...bucket, KIPPU_METADATA_PUBLIC_URL: value })).toThrow(
        MetadataConfigError,
      );
    }
  });

  it("requires a bucket, and both halves of static credentials or neither", () => {
    expect(() => loadMetadataConfig({})).toThrow(/KIPPU_METADATA_S3_BUCKET/);
    expect(() =>
      loadMetadataConfig({ ...bucket, KIPPU_METADATA_S3_ACCESS_KEY_ID: "local" }),
    ).toThrow(MetadataConfigError);
    expect(() =>
      loadMetadataConfig({ ...bucket, KIPPU_METADATA_S3_FORCE_PATH_STYLE: "yes" }),
    ).toThrow(MetadataConfigError);
  });

  it("reads where the local CDN stand-in listens", () => {
    expect(loadMetadataEdgeConfig(bucket)).toMatchObject({ host: "0.0.0.0", port: 8081 });
    expect(
      loadMetadataEdgeConfig({
        ...bucket,
        KIPPU_METADATA_EDGE_HOST: "127.0.0.1",
        KIPPU_METADATA_EDGE_PORT: "9100",
      }),
    ).toMatchObject({ host: "127.0.0.1", port: 9100 });
    expect(() => loadMetadataEdgeConfig({ ...bucket, KIPPU_METADATA_EDGE_PORT: "http" })).toThrow(
      MetadataConfigError,
    );
  });
});

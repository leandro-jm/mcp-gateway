import {
  CreateBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

export interface ArtifactStoreConfig {
  endpoint: string;
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** MinIO and the like require path-style. */
  forcePathStyle?: boolean;
}

/** Artifact store on S3/MinIO (F8.1). Bytes only; metadata and ownership live in Postgres. */
export class ArtifactStore {
  private readonly s3: S3Client;
  readonly bucket: string;

  constructor(cfg: ArtifactStoreConfig) {
    this.bucket = cfg.bucket;
    this.s3 = new S3Client({
      endpoint: cfg.endpoint,
      region: cfg.region ?? 'us-east-1',
      forcePathStyle: cfg.forcePathStyle ?? true,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
  }

  static key(tenantId: string, sessionId: string, callId: string): string {
    return `${tenantId}/${sessionId}/${callId}.json`;
  }

  async ensureBucket(): Promise<void> {
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      await this.s3.send(new CreateBucketCommand({ Bucket: this.bucket })).catch((err: { name?: string }) => {
        if (err.name !== 'BucketAlreadyOwnedByYou' && err.name !== 'BucketAlreadyExists') throw err;
      });
    }
  }

  async put(key: string, body: string | Buffer, contentType = 'application/json'): Promise<void> {
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }));
  }

  async getText(key: string, maxBytes?: number): Promise<string> {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    if (maxBytes && (res.ContentLength ?? 0) > maxBytes) throw new Error(`artifact exceeds ${maxBytes} bytes`);
    return (await res.Body?.transformToString('utf-8')) ?? '';
  }

  async deleteMany(keys: string[]): Promise<void> {
    for (let i = 0; i < keys.length; i += 1000) {
      const chunk = keys.slice(i, i + 1000);
      if (!chunk.length) continue;
      await this.s3.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true } }));
    }
  }

  /** Checks access to the bucket (readiness). */
  async ping(): Promise<void> {
    await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }));
  }

  close(): void {
    this.s3.destroy();
  }
}

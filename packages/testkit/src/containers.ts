import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';

export interface StartedService {
  container: StartedTestContainer;
  stop(): Promise<void>;
}

export interface StartedPostgres extends StartedService {
  url: string;
}

export interface StartedRedis extends StartedService {
  url: string;
}

export interface StartedMinio extends StartedService {
  endpoint: string;
  accessKey: string;
  secretKey: string;
}

export async function startPostgres(): Promise<StartedPostgres> {
  const container = await new GenericContainer('pgvector/pgvector:pg17')
    .withEnvironment({ POSTGRES_USER: 'test', POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'test' })
    .withExposedPorts(5432)
    .withTmpFs({ '/var/lib/postgresql/data': 'rw' })
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  const url = `postgres://test:test@${container.getHost()}:${container.getMappedPort(5432)}/test`;
  return { container, url, stop: async () => void (await container.stop()) };
}

export async function startRedis(): Promise<StartedRedis> {
  const container = await new GenericContainer('redis:7-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();
  const url = `redis://${container.getHost()}:${container.getMappedPort(6379)}`;
  return { container, url, stop: async () => void (await container.stop()) };
}

export async function startMinio(): Promise<StartedMinio> {
  const accessKey = 'testaccess';
  const secretKey = 'testsecret123';
  const container = await new GenericContainer('cgr.dev/chainguard/minio:latest')
    .withCommand(['server', '/data'])
    .withEnvironment({ MINIO_ROOT_USER: accessKey, MINIO_ROOT_PASSWORD: secretKey })
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp('/minio/health/ready', 9000))
    .start();
  const endpoint = `http://${container.getHost()}:${container.getMappedPort(9000)}`;
  return { container, endpoint, accessKey, secretKey, stop: async () => void (await container.stop()) };
}

/** Embeddings provider (optional). Without one, search is lexical only. */
export interface EmbeddingProvider {
  readonly name: string;
  embed(texts: string[]): Promise<number[][]>;
}

/** Client for APIs compatible with `POST /embeddings` (OpenAI, Ollama, vLLM, LiteLLM…). */
export class HttpEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;

  constructor(
    private readonly url: string,
    private readonly model: string,
    private readonly apiKey?: string,
    private readonly timeoutMs = 10_000,
  ) {
    this.name = `http:${model}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
      body: JSON.stringify({ model: this.model, input: texts }),
      // a redirect would carry the API key to another host
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`embeddings provider responded HTTP ${res.status}`);
    const json = (await res.json()) as { data: Array<{ embedding: number[]; index: number }> };
    return [...json.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}

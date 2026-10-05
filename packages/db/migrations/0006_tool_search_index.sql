-- Busca de tools (F7.1): FTS português + simple, sem acentos; embeddings opcionais (pgvector).
-- Escrita à mão (drizzle-kit não expressa configurações de text search nem colunas geradas tsvector).
CREATE EXTENSION IF NOT EXISTS unaccent;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TEXT SEARCH CONFIGURATION pt_unaccent (COPY = portuguese);
ALTER TEXT SEARCH CONFIGURATION pt_unaccent
  ALTER MAPPING FOR hword, hword_part, word WITH unaccent, portuguese_stem;

CREATE TEXT SEARCH CONFIGURATION simple_unaccent (COPY = simple);
ALTER TEXT SEARCH CONFIGURATION simple_unaccent
  ALTER MAPPING FOR hword, hword_part, word WITH unaccent, simple;

ALTER TABLE tools ADD COLUMN search_tsv tsvector GENERATED ALWAYS AS (
  setweight(to_tsvector('simple_unaccent'::regconfig, regexp_replace(search_text, '[_]', ' ', 'g')), 'A') ||
  setweight(to_tsvector('pt_unaccent'::regconfig, regexp_replace(search_text, '[_]', ' ', 'g')), 'B')
) STORED;
CREATE INDEX tools_search_tsv_idx ON tools USING gin (search_tsv);

-- Dimensão livre: o provedor de embeddings é configurável.
ALTER TABLE tools ADD COLUMN embedding vector;

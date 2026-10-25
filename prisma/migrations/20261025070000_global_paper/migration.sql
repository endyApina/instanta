CREATE TABLE "GlobalPaperAccount" (
  id TEXT PRIMARY KEY, "userId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT,
  asset VARCHAR(8) NOT NULL CHECK (asset IN ('USD','USDT','USDC')), code TEXT NOT NULL,
  "normalBalance" "LedgerSide" NOT NULL, balance DECIMAL(30,8) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  CHECK (("normalBalance" = 'CREDIT' AND code IN ('SIMULATED_CAPITAL','REALIZED_GAIN'))
    OR ("normalBalance" = 'DEBIT' AND (code IN ('CASH','REALIZED_LOSS') OR code LIKE 'POSITION:%'))),
  UNIQUE ("userId", asset, code)
);
CREATE TABLE "GlobalPaperJournal" (
  id TEXT PRIMARY KEY, reference TEXT NOT NULL UNIQUE, "requestHash" TEXT NOT NULL,
  asset VARCHAR(8) NOT NULL CHECK (asset IN ('USD','USDT','USDC')),
  description TEXT NOT NULL, "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE "GlobalPaperLine" (
  id TEXT PRIMARY KEY, "journalId" TEXT NOT NULL REFERENCES "GlobalPaperJournal"(id) ON DELETE RESTRICT,
  "accountId" TEXT NOT NULL REFERENCES "GlobalPaperAccount"(id) ON DELETE RESTRICT,
  side "LedgerSide" NOT NULL, amount DECIMAL(30,8) NOT NULL CHECK (amount > 0)
);
CREATE INDEX "GlobalPaperLine_accountId_idx" ON "GlobalPaperLine"("accountId");
CREATE INDEX "GlobalPaperLine_journalId_idx" ON "GlobalPaperLine"("journalId");
CREATE TABLE "GlobalPaperPosition" (
  id TEXT PRIMARY KEY, "userId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT,
  symbol TEXT NOT NULL, asset VARCHAR(8) NOT NULL CHECK (asset IN ('USD','USDT','USDC')),
  qty DECIMAL(30,8) NOT NULL DEFAULT 0 CHECK (qty >= 0), cost DECIMAL(30,8) NOT NULL DEFAULT 0 CHECK (cost >= 0),
  CHECK ((qty = 0) = (cost = 0)), UNIQUE ("userId", symbol, asset)
);
CREATE TABLE "GlobalPaperOrder" (
  id TEXT PRIMARY KEY, "userId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE RESTRICT,
  "requestKey" TEXT NOT NULL UNIQUE, "requestHash" TEXT NOT NULL,
  symbol TEXT NOT NULL, side TEXT NOT NULL CHECK (side IN ('BUY','SELL')),
  asset VARCHAR(8) NOT NULL CHECK (asset IN ('USD','USDT','USDC')),
  qty DECIMAL(30,8) NOT NULL CHECK (qty > 0), price DECIMAL(30,8) NOT NULL CHECK (price > 0),
  amount DECIMAL(30,8) NOT NULL CHECK (amount > 0), risk JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "GlobalPaperOrder_userId_createdAt_idx" ON "GlobalPaperOrder"("userId", "createdAt");

CREATE FUNCTION instanta_check_global_paper() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE journal_id TEXT; account_id TEXT; cached NUMERIC; computed NUMERIC;
BEGIN
  IF TG_TABLE_NAME = 'GlobalPaperJournal' THEN journal_id := NEW.id;
  ELSIF TG_TABLE_NAME = 'GlobalPaperLine' THEN journal_id := NEW."journalId"; END IF;
  IF journal_id IS NOT NULL AND NOT EXISTS (
    SELECT j.id FROM "GlobalPaperJournal" j JOIN "GlobalPaperLine" l ON l."journalId" = j.id
    JOIN "GlobalPaperAccount" a ON a.id = l."accountId" WHERE j.id = journal_id
    GROUP BY j.id HAVING count(*) >= 2 AND count(DISTINCT a."userId") = 1
      AND bool_and(a.asset = j.asset)
      AND sum(CASE WHEN l.side = 'DEBIT' THEN l.amount ELSE -l.amount END) = 0
  ) THEN RAISE EXCEPTION 'Unbalanced or cross-asset paper journal' USING ERRCODE = '23514'; END IF;
  IF TG_TABLE_NAME = 'GlobalPaperAccount' THEN account_id := NEW.id;
  ELSIF TG_TABLE_NAME = 'GlobalPaperLine' THEN account_id := NEW."accountId"; END IF;
  IF account_id IS NOT NULL THEN
    SELECT a.balance, coalesce(sum(CASE WHEN l.side = a."normalBalance" THEN l.amount ELSE -l.amount END),0)
    INTO cached, computed FROM "GlobalPaperAccount" a LEFT JOIN "GlobalPaperLine" l ON l."accountId" = a.id
    WHERE a.id = account_id GROUP BY a.id;
    IF cached <> computed THEN RAISE EXCEPTION 'Paper cached balance differs from history' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER global_paper_journal_valid AFTER INSERT ON "GlobalPaperJournal"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION instanta_check_global_paper();
CREATE CONSTRAINT TRIGGER global_paper_line_valid AFTER INSERT ON "GlobalPaperLine"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION instanta_check_global_paper();
CREATE CONSTRAINT TRIGGER global_paper_balance_valid AFTER INSERT OR UPDATE ON "GlobalPaperAccount"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION instanta_check_global_paper();
CREATE TRIGGER global_paper_journal_immutable BEFORE UPDATE OR DELETE ON "GlobalPaperJournal"
FOR EACH ROW EXECUTE FUNCTION instanta_immutable_history();
CREATE TRIGGER global_paper_line_immutable BEFORE UPDATE OR DELETE ON "GlobalPaperLine"
FOR EACH ROW EXECUTE FUNCTION instanta_immutable_history();
CREATE TRIGGER global_paper_order_immutable BEFORE UPDATE OR DELETE ON "GlobalPaperOrder"
FOR EACH ROW EXECUTE FUNCTION instanta_immutable_history();

CREATE FUNCTION instanta_check_paper_position() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_id TEXT; ccy TEXT; sym TEXT; stored_cost NUMERIC; posted_cost NUMERIC;
BEGIN
  IF TG_TABLE_NAME = 'GlobalPaperPosition' THEN
    owner_id := NEW."userId"; ccy := NEW.asset; sym := NEW.symbol;
  ELSIF NEW.code LIKE 'POSITION:%' THEN
    owner_id := NEW."userId"; ccy := NEW.asset; sym := substring(NEW.code FROM 10);
  ELSE RETURN NULL; END IF;
  SELECT cost INTO stored_cost FROM "GlobalPaperPosition" WHERE "userId" = owner_id AND asset = ccy AND symbol = sym;
  SELECT balance INTO posted_cost FROM "GlobalPaperAccount" WHERE "userId" = owner_id AND asset = ccy AND code = 'POSITION:' || sym;
  IF coalesce(stored_cost,0) <> coalesce(posted_cost,0) THEN
    RAISE EXCEPTION 'Paper position cost differs from ledger' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER global_paper_position_cost AFTER INSERT OR UPDATE ON "GlobalPaperPosition"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION instanta_check_paper_position();
CREATE CONSTRAINT TRIGGER global_paper_account_position_cost AFTER INSERT OR UPDATE ON "GlobalPaperAccount"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION instanta_check_paper_position();

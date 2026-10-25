-- Defense in depth: application-level validation alone cannot prevent a faulty writer
-- from committing orphan lines or changing previously posted financial history.
ALTER TABLE "Transaction" ADD CONSTRAINT "positive_amount" CHECK (amount > 0);
ALTER TABLE "LedgerAccount" ADD CONSTRAINT "nonnegative_balance" CHECK (balance >= 0);
ALTER TABLE "LedgerAccount" ADD CONSTRAINT "normal_side_matches_type" CHECK (
  ("accountType" IN ('ASSET', 'EXPENSE') AND "normalBalance" = 'DEBIT')
  OR ("accountType" IN ('LIABILITY', 'EQUITY', 'REVENUE') AND "normalBalance" = 'CREDIT')
);
INSERT INTO "SystemControl" (id, "readOnly") VALUES ('global', false);

CREATE FUNCTION instanta_check_journal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  journal_id text;
  line_count bigint;
  debits numeric;
  credits numeric;
  invalid_currency bigint;
BEGIN
  IF TG_TABLE_NAME = 'JournalEntry' THEN
    journal_id := NEW.id;
  ELSE
    journal_id := NEW."journalEntryId";
  END IF;
  SELECT count(*),
    coalesce(sum(CASE WHEN t.side = 'DEBIT' THEN t.amount ELSE 0 END), 0),
    coalesce(sum(CASE WHEN t.side = 'CREDIT' THEN t.amount ELSE 0 END), 0),
    count(*) FILTER (WHERE t.currency <> j.currency OR t.currency <> a.currency)
  INTO line_count, debits, credits, invalid_currency
  FROM "Transaction" t JOIN "JournalEntry" j ON j.id = t."journalEntryId"
    JOIN "LedgerAccount" a ON a.id = t."ledgerAccountId"
  WHERE t."journalEntryId" = journal_id;
  IF line_count < 2 OR debits <= 0 OR debits <> credits OR invalid_currency > 0 THEN
    RAISE EXCEPTION 'Unbalanced or invalid journal' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER journal_balanced_at_commit
AFTER INSERT ON "JournalEntry" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION instanta_check_journal();
CREATE CONSTRAINT TRIGGER lines_balanced_at_commit
AFTER INSERT ON "Transaction" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION instanta_check_journal();

CREATE FUNCTION instanta_check_cached_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  cached numeric;
  computed numeric;
  account_id text;
BEGIN
  IF TG_TABLE_NAME = 'LedgerAccount' THEN account_id := NEW.id;
  ELSE account_id := NEW."ledgerAccountId";
  END IF;
  SELECT a.balance, coalesce(sum(CASE WHEN t.side = a."normalBalance" THEN t.amount ELSE -t.amount END), 0)
  INTO cached, computed
  FROM "LedgerAccount" a LEFT JOIN "Transaction" t ON t."ledgerAccountId" = a.id
  WHERE a.id = account_id GROUP BY a.id;
  IF cached <> computed THEN
    RAISE EXCEPTION 'Ledger cached balance differs from journal history' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER cached_balance_at_commit
AFTER INSERT OR UPDATE ON "LedgerAccount" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION instanta_check_cached_balance();
CREATE CONSTRAINT TRIGGER line_cached_balance_at_commit
AFTER INSERT ON "Transaction" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION instanta_check_cached_balance();

CREATE FUNCTION instanta_immutable_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Posted journals, lines and audit history are immutable; use compensating entries'
    USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER immutable_journals BEFORE UPDATE OR DELETE ON "JournalEntry"
FOR EACH ROW EXECUTE FUNCTION instanta_immutable_history();
CREATE TRIGGER immutable_lines BEFORE UPDATE OR DELETE ON "Transaction"
FOR EACH ROW EXECUTE FUNCTION instanta_immutable_history();
CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE ON "AuditEvent"
FOR EACH ROW EXECUTE FUNCTION instanta_immutable_history();

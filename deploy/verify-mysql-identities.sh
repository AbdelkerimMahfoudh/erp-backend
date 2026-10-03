#!/usr/bin/env bash
# Prove what each database identity CANNOT do (docs/48 §2.2–2.5).
#
#   DB=phonestore MYSQL_HOST=127.0.0.1 MYSQL_PORT=3306 \
#   APP_PW=… BACKUP_PW=… MIGRATOR_PW=… deploy/verify-mysql-identities.sh
#
# Runs against a COPY or a disposable database, never the live one: it inserts
# and then tries to alter a row in audit_logs, and it attempts DDL as the
# application account. Every attempt that must fail is asserted to fail;
# every attempt that must succeed is asserted to succeed. Exit 1 on any
# surprise. Pass MYSQL_SOCKET instead of host/port for a local socket.
set -u
DB=${DB:-phonestore}
CONN=()
if [ -n "${MYSQL_SOCKET:-}" ]; then CONN=(--socket "$MYSQL_SOCKET"); else CONN=(-h "${MYSQL_HOST:-127.0.0.1}" -P "${MYSQL_PORT:-3306}" --protocol=TCP); fi
pass=0; fail=0
ok()   { pass=$((pass+1)); echo "PASS $1"; }
bad()  { fail=$((fail+1)); echo "FAIL $1"; }
# run USER PW SQL → prints "ok" or the error text
run() { MYSQL_PWD="$2" mysql "${CONN[@]}" -u "$1" -N -B "$DB" -e "$3" 2>&1 && echo "__ok__"; }
must_fail() { # name user pw sql expected-error-fragment
  out=$(run "$2" "$3" "$4"); if echo "$out" | grep -q "__ok__"; then bad "$1 (succeeded, must be refused)"; else if echo "$out" | grep -qi "$5"; then ok "$1"; else bad "$1 (refused, but not for the expected reason: $(echo "$out" | head -1))"; fi; fi; }
must_pass() { out=$(run "$2" "$3" "$4"); if echo "$out" | grep -q "__ok__"; then ok "$1"; else bad "$1: $(echo "$out" | head -1)"; fi; }

echo "=== $DB via ${MYSQL_SOCKET:-${MYSQL_HOST:-127.0.0.1}:${MYSQL_PORT:-3306}}"

# --- the application account: DML yes, DDL no, audit rewrite no ----------------
must_pass "app can read"                       phonestore_app "$APP_PW" "SELECT COUNT(*) FROM companies"
must_fail "app cannot alter a table"           phonestore_app "$APP_PW" "ALTER TABLE companies ADD COLUMN x INT" "denied"
must_fail "app cannot create a table"          phonestore_app "$APP_PW" "CREATE TABLE zz_probe (id INT)" "denied"
must_fail "app cannot drop a table"            phonestore_app "$APP_PW" "DROP TABLE audit_logs" "denied"
must_fail "app cannot create a trigger"        phonestore_app "$APP_PW" "CREATE TRIGGER zz BEFORE INSERT ON companies FOR EACH ROW SET NEW.name = NEW.name" "denied"
must_fail "app cannot grant"                   phonestore_app "$APP_PW" "GRANT SELECT ON $DB.* TO 'phonestore_app'@'%'" "denied"
must_fail "app cannot read another schema"     phonestore_app "$APP_PW" "SELECT COUNT(*) FROM mysql.user" "denied"

# A company to hang an audit row on (the row is left in place; this is a copy).
COMPANY_HEX=$(MYSQL_PWD="$APP_PW" mysql "${CONN[@]}" -u phonestore_app -N -B "$DB" -e "SELECT HEX(id) FROM companies LIMIT 1" 2>/dev/null)
if [ -n "$COMPANY_HEX" ]; then
  # The three below pass only on the TRIGGER's own refusal (SIGNAL 45000, "... is
  # append-only"). A refusal for want of a grant would say "denied" and prove
  # nothing about the trigger — the restore drill made that mistake (2026-10-03).
  must_pass "app can append an audit row"      phonestore_app "$APP_PW" "INSERT INTO audit_logs (company_id, entity_type, action, reason) VALUES (UNHEX('$COMPANY_HEX'), 'IdentityProbe', 'create', 'verify-mysql-identities')"
  must_fail "app cannot UPDATE an audit row (trigger)" phonestore_app "$APP_PW" "UPDATE audit_logs SET reason='tampered' WHERE entity_type='IdentityProbe'" "append-only"
  must_fail "app cannot DELETE an audit row (trigger)" phonestore_app "$APP_PW" "DELETE FROM audit_logs WHERE entity_type='IdentityProbe'" "append-only"
  must_fail "app cannot rewrite a subscription event (trigger)" phonestore_app "$APP_PW" "UPDATE subscription_events SET note='tampered' WHERE company_id=UNHEX('$COMPANY_HEX')" "append-only"
else
  echo "SKIP audit-trigger probes: no company row in $DB"
fi

# --- the backup account: read everything, change nothing ----------------------
if [ -n "${BACKUP_PW:-}" ]; then
  must_pass "backup can read"                  phonestore_backup "$BACKUP_PW" "SELECT COUNT(*) FROM audit_logs"
  must_fail "backup cannot insert"             phonestore_backup "$BACKUP_PW" "INSERT INTO settings (id, company_id, \`key\`, value) VALUES (UNHEX('00'), UNHEX('00'), 'x', '{}')" "denied"
  must_fail "backup cannot update"             phonestore_backup "$BACKUP_PW" "UPDATE companies SET name=name" "denied"
  must_fail "backup cannot delete"             phonestore_backup "$BACKUP_PW" "DELETE FROM notifications" "denied"
  must_fail "backup cannot alter"              phonestore_backup "$BACKUP_PW" "ALTER TABLE companies ADD COLUMN x INT" "denied"
  must_pass "backup can dump the schema objects" phonestore_backup "$BACKUP_PW" "SHOW TRIGGERS"
else
  echo "SKIP backup probes: BACKUP_PW not set"
fi

# --- the migrator: DDL on its schema only -------------------------------------
if [ -n "${MIGRATOR_PW:-}" ]; then
  must_pass "migrator can alter its schema"    phonestore_migrator "$MIGRATOR_PW" "CREATE TABLE zz_probe (id INT); DROP TABLE zz_probe"
  must_fail "migrator cannot touch mysql.*"    phonestore_migrator "$MIGRATOR_PW" "SELECT COUNT(*) FROM mysql.user" "denied"
  must_fail "migrator cannot grant server-wide" phonestore_migrator "$MIGRATOR_PW" "GRANT ALL ON *.* TO 'phonestore_app'@'%'" "denied"
fi

echo "=== $pass passed, $fail failed"
[ "$fail" -eq 0 ]

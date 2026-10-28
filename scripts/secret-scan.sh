#!/usr/bin/env bash
# Scans everything that would be committed (tracked and not ignored) for secrets and
# personal data. Any hit exits non-zero and blocks the push.
set -uo pipefail
cd "$(dirname "$0")/.."

FILES=$(git ls-files --cached --others --exclude-standard 2>/dev/null | grep -v -E '^(package-lock\.json|scripts/secret-scan\.sh|\.gitleaks\.toml)$' || true)
if [ -z "$FILES" ]; then
  echo "secret-scan: no files to scan"
  exit 0
fi

fail=0
check() {
  local label="$1" pattern="$2"
  local hits
  hits=$(echo "$FILES" | xargs grep -n -I -E -i -- "$pattern" 2>/dev/null || true)
  if [ -n "$hits" ]; then
    echo "BLOCKED: $label"
    echo "$hits" | sed 's/^/  /' | cut -c1-200
    fail=1
  fi
}

# Email addresses. Allowed on purpose: LinkedIn's automated no-reply senders (named in the
# source config) and the reserved example domains from RFC 2606 (never a real mailbox).
EMAIL='[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}'
hits=$(echo "$FILES" | xargs grep -n -I -E -o -- "$EMAIL" 2>/dev/null | grep -v -E '@linkedin\.com$|@example\.(org|com|net)$' || true)
if [ -n "$hits" ]; then
  echo "BLOCKED: email address"
  echo "$hits" | sed 's/^/  /' | cut -c1-200
  fail=1
fi

# Phone numbers. The 555-01xx range is reserved for fiction and is allowed.
phone_hits=$(echo "$FILES" | xargs grep -n -I -E -o -- '(\+?1[ .-]?)?\(?[0-9]{3}\)?[ .-][0-9]{3}[ .-][0-9]{4}\b' 2>/dev/null | grep -v -E '555[ .-]01[0-9]{2}$' || true)
if [ -n "$phone_hits" ]; then
  echo "BLOCKED: phone number"
  echo "$phone_hits" | sed 's/^/  /' | cut -c1-200
  fail=1
fi
check "personal name" '\b(jonathon|westbrook)\b'
check "private network name" 'tailscale'
check "private network address (100.x.x.x)" '\b100\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\b'
check "local filesystem path" '/Users/'
check "Google Drive link" 'drive\.google\.com'
check "LinkedIn profile link" 'linkedin\.com/in/'
check "private key or token" '(BEGIN [A-Z ]*PRIVATE KEY|ya29\.[A-Za-z0-9._-]{10,}|xox[baprs]-[A-Za-z0-9-]{10,}|sk-[A-Za-z0-9]{20,})'

# Commit metadata. Commits that are not on the remote yet must use a noreply author address
# and must not carry the owner's name. Already-pushed history is reported by the audit, not blocked.
UNPUSHED=$(git log --format='%H %an <%ae>' "@{upstream}..HEAD" 2>/dev/null || git log --format='%H %an <%ae>' HEAD)
if [ -n "$UNPUSHED" ]; then
  bad_author=$(echo "$UNPUSHED" | grep -v -E 'users\.noreply\.github\.com>$' || true)
  if [ -n "$bad_author" ]; then
    echo "BLOCKED: commit author is not a noreply address"
    echo "$bad_author" | cut -c1-120 | sed 's/^/  /'
    fail=1
  fi
  bad_name=$(echo "$UNPUSHED" | grep -i -E 'jonathon|westbrook' || true)
  if [ -n "$bad_name" ]; then
    echo "BLOCKED: commit author name is personal"
    fail=1
  fi
fi

if command -v gitleaks >/dev/null 2>&1; then
  log=$(mktemp)
  if ! gitleaks detect --no-git --source . --config .gitleaks.toml --redact --no-banner --exit-code 1 >"$log" 2>&1; then
    echo "BLOCKED: gitleaks reported findings"
    cut -c1-200 "$log" | head -40
    fail=1
  fi
  rm -f "$log"
else
  echo "warning: gitleaks is not installed; pattern scan only"
fi

if [ "$fail" -ne 0 ]; then
  echo "secret-scan: FAILED. Do not push."
  exit 1
fi
echo "secret-scan: clean ($(echo "$FILES" | wc -l | tr -d ' ') files)"

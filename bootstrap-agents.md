# BOOTSTRAP AGENTS.MD (AUTO-GENERATED SAFE DEFAULT)
# This file exists because no agents.md was found.
# It is intentionally minimal and safe.

RULE: STOP BEFORE ACTION
No infrastructure changes are allowed until required files exist.

==================================================
REQUIRED FILES
==================================================

You MUST have:
- systemrules.md
- global-Infrastructure.md
- global-PROJECT_SETUP_GUIDELINES.md
- distributed_ai_control_execution_spec_for_open_code.md

If any are missing:
STOP and ask.
Do not guess.

==================================================
AGENTS.LOCAL.MD
==================================================

If agents.local.md exists, read it for:
- OS/DISTRO/ROLE/HOST
- CAPABILITIES
- AI routing

If not present:
do not assume prod/staging/dev.

==================================================
DELEGATION
==================================================

Route by:
CAPABILITIES > TOOLS > OS

==================================================
SAFETY
==================================================

- never run as root
- backup before change
- no destructive operations
- no major version upgrades unless explicitly requested

==================================================
LOCAL AI
==================================================

Prefer local Ollama if available.
Do not send secrets to cloud.

==================================================
FAILSAFE
==================================================

When uncertain:
STOP and ask.

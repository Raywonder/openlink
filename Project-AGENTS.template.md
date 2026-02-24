# Project AGENTS.md (Template)
# Place at: dev/apps/<project>/AGENTS.md

This file extends dev/apps/AGENTS.md and root agents.md.
It must never override infrastructure governance.

==================================================
PROJECT IDENTITY
==================================================

Project name:
Primary purpose:
Primary runtime:
- Node/PM2 | Docker | PHP | Other
Primary host targets:
- dev (mac/windows)
- staging (vps ubuntu 22.04)
- prod (main almalinux)

Key ports:
Public URLs/domains:

Key directories:
- config:
- data:
- logs:
- backups:

==================================================
PROJECT COMMANDS
==================================================

Dev start:
Staging deploy:
Prod deploy:
Health check:
Backup:
Restore:

==================================================
SPECIAL RULES
==================================================

- Any sensitive data handling rules
- Any client-specific requirements
- Any domain/nginx caveats

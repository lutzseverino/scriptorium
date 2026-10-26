# Scriptorium's toolchain: Node.js 24 and pnpm 11.28.8, as named in the
# development guide. The factory's agent layer adds Git and the GitHub CLI.
# The sandbox has no Docker daemon, so image tests skip there; CI runs them.
FROM node:24-bookworm

RUN npm install --global pnpm@11.28.8

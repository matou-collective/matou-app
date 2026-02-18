# Automated Deployment

## 🚀 Release & Build Process

This repository uses a **tag → release → build** workflow to ensure safe, repeatable releases.

### Overview

1. **Local script** creates a version bump + Git tag
2. **GitHub Actions** creates a draft release when the tag is pushed
3. **Build workflow** runs when the release is created
4. Artifacts are uploaded to the draft release using electron
5. Release is manually published when ready

---

## 🧩 Components

### 1. `scripts/release.sh` (local)

Run from the `frontend/` directory:

```bash
npm run release -- <version>
```

This runs a script to update the version in `frontend/package.json`, creates a tag for the new version, commits and pushes it to both the GitLab and GitHub repos.

Notes:

* Currently only tested on MacOS
* Assumes you have the following remotes set up:

  ```bash
  github git@github.com:matou-collective/matou-app.git (fetch)
  github git@github.com:matou-collective/matou-app.git (push)
  origin git@gitlab.com:matou-collective/matou-app.git (fetch)
  origin git@gitlab.com:matou-collective/matou-app.git (push)
  ```

---

### 2. Matou App Build and Release (GitHub Actions)

The build is automatically triggered when a new tag is pushed
See [Matou App Build](https://github.com/matou-collective/matou-app/actions/workflows/build.yml). Electron handles creating a release, and building and uploading the installers to the release.

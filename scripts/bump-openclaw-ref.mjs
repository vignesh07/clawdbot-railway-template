import fs from "node:fs";
import childProcess from "node:child_process";

const owner = "openclaw";
const repo = "openclaw";
const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error("Missing GITHUB_TOKEN");
  process.exit(2);
}

async function gh(path) {
  const url = `https://api.github.com${path}`;
  const res = await fetch(url, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "clawdbot-railway-template-bot",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

function readCurrentTag(dockerfile) {
  const m = dockerfile.match(/\nARG OPENCLAW_GIT_REF=([^\n]+)\n/);
  return m ? m[1].trim() : null;
}

function replaceTag(dockerfile, next) {
  const re = /\nARG OPENCLAW_GIT_REF=([^\n]+)\n/;
  if (!re.test(dockerfile)) throw new Error("Could not find OPENCLAW_GIT_REF line");
  return dockerfile.replace(re, `\nARG OPENCLAW_GIT_REF=${next}\n`);
}

function readPackageVersion(pkg) {
  return pkg?.dependencies?.openclaw ?? null;
}

function writePackageVersion(pkg, nextVersion) {
  if (!pkg.dependencies?.openclaw) {
    throw new Error("Could not find dependencies.openclaw in package.json");
  }
  pkg.dependencies.openclaw = nextVersion;
  return pkg;
}

const latest = await gh(`/repos/${owner}/${repo}/releases/latest`);
const latestTag = latest.tag_name;
if (!latestTag) throw new Error("No tag_name in latest release response");
const latestVersion = latestTag.replace(/^v/, "");

const dockerPath = "Dockerfile";
const docker = fs.readFileSync(dockerPath, "utf8");
const currentTag = readCurrentTag(docker);
if (!currentTag) throw new Error("Could not parse current OPENCLAW_GIT_REF");

const packageJsonPath = "package.json";
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
const currentVersion = readPackageVersion(packageJson);
if (!currentVersion) throw new Error("Could not parse package.json openclaw version");

console.log(`currentTag=${currentTag} currentVersion=${currentVersion} latestTag=${latestTag} latestVersion=${latestVersion}`);

if (currentTag === latestTag && currentVersion === latestVersion) {
  console.log("No update needed.");
  process.exit(0);
}

fs.writeFileSync(dockerPath, replaceTag(docker, latestTag));
fs.writeFileSync(
  packageJsonPath,
  `${JSON.stringify(writePackageVersion(packageJson, latestVersion), null, 2)}\n`,
);

childProcess.execFileSync("npm", ["install", "--package-lock-only"], {
  stdio: "inherit",
});

console.log(`Updated ${dockerPath} to ${latestTag}`);
console.log(`Updated ${packageJsonPath} to ${latestVersion}`);
console.log("Updated package-lock.json");

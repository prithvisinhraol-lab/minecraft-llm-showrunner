import { mkdir, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

const manifestUrl = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const requestedVersion = process.env.MC_SERVER_VERSION;
const serverDir = path.resolve('server');
const jarPath = path.join(serverDir, 'server.jar');

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function downloadFile(url, destination) {
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  await pipeline(response.body, createWriteStream(destination));
}

const manifest = await getJson(manifestUrl);
const versionId = requestedVersion || manifest.latest.release;
const versionEntry = manifest.versions.find((version) => version.id === versionId);

if (!versionEntry) {
  throw new Error(`Could not find Minecraft server version "${versionId}" in Mojang manifest.`);
}

const versionDetails = await getJson(versionEntry.url);
const serverDownload = versionDetails.downloads?.server;

if (!serverDownload?.url) {
  throw new Error(`Minecraft version "${versionId}" does not provide a server download.`);
}

await mkdir(serverDir, { recursive: true });
await downloadFile(serverDownload.url, jarPath);
await writeFile(path.join(serverDir, 'VERSION.txt'), `${versionId}\n`);

console.log(`Downloaded Minecraft server ${versionId} to ${jarPath}`);

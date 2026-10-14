import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const WEB_TAG =
    /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-web\.[1-9]\d*)$/;

export function webReleaseMetadata(
    tag: string,
    repository: string,
    sha: string
) {
    const match = WEB_TAG.exec(tag);
    if (!match || match[1].length > 128) {
        throw new Error('Expected a release tag such as v2.32.0-web.1');
    }
    const name = repository.toLowerCase();
    if (
        !/^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(name)
    ) {
        throw new Error('Invalid GitHub repository name');
    }
    if (!/^[a-f0-9]{40}$/.test(sha)) {
        throw new Error('Expected the full commit SHA');
    }
    return {
        image: `ghcr.io/${name}`,
        version: match[1],
        sha_tag: `sha-${sha}`
    };
}

export async function assertUnpublished(
    release: ReturnType<typeof webReleaseMetadata>,
    actor: string,
    githubToken: string
): Promise<void> {
    if (!actor || !githubToken) {
        throw new Error('GitHub actor and token are required to check GHCR');
    }
    const name = release.image.slice('ghcr.io/'.length);
    const tokenUrl = new URL('https://ghcr.io/token');
    tokenUrl.searchParams.set('service', 'ghcr.io');
    tokenUrl.searchParams.set('scope', `repository:${name}:pull,push`);
    const tokenResponse = await fetch(tokenUrl, {
        headers: {
            Authorization: `Basic ${Buffer.from(`${actor}:${githubToken}`).toString('base64')}`
        },
        redirect: 'error',
        signal: AbortSignal.timeout(30_000)
    });
    if (!tokenResponse.ok) {
        throw new Error(
            `GHCR authentication failed: HTTP ${tokenResponse.status}`
        );
    }
    const credentials = (await tokenResponse.json()) as { token?: unknown };
    if (typeof credentials.token !== 'string' || !credentials.token) {
        throw new Error('GHCR did not return a registry token');
    }
    const response = await fetch(
        `https://ghcr.io/v2/${name}/manifests/${release.version}`,
        {
            method: 'HEAD',
            headers: {
                Authorization: `Bearer ${credentials.token}`,
                Accept: [
                    'application/vnd.oci.image.manifest.v1+json',
                    'application/vnd.oci.image.index.v1+json',
                    'application/vnd.docker.distribution.manifest.v2+json',
                    'application/vnd.docker.distribution.manifest.list.v2+json'
                ].join(', ')
            },
            redirect: 'error',
            signal: AbortSignal.timeout(30_000)
        }
    );
    if (response.status === 404) return;
    if (response.ok) {
        throw new Error(
            `Refusing to overwrite ${release.image}:${release.version}`
        );
    }
    throw new Error(
        `Cannot verify unpublished version: HTTP ${response.status}`
    );
}

async function main() {
    const release = webReleaseMetadata(
        process.env.GITHUB_REF_NAME ?? '',
        process.env.GITHUB_REPOSITORY ?? '',
        process.env.GITHUB_SHA ?? ''
    );
    switch (process.argv[2]) {
        case 'metadata': {
            const output = Object.entries(release)
                .map(([key, value]) => `${key}=${value}`)
                .join('\n');
            console.log(output);
            if (process.env.GITHUB_OUTPUT) {
                fs.appendFileSync(process.env.GITHUB_OUTPUT, `${output}\n`);
            }
            break;
        }
        case 'check-unpublished':
            await assertUnpublished(
                release,
                process.env.GITHUB_ACTOR ?? '',
                process.env.GH_TOKEN ?? ''
            );
            break;
        default:
            throw new Error('Usage: web-release.ts metadata|check-unpublished');
    }
}

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
    main().catch((error: unknown) => {
        console.error(
            error instanceof Error ? error.message : 'Release failed'
        );
        process.exitCode = 1;
    });
}

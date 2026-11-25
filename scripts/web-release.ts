import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const WEB_TAG =
    /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-web\.[1-9]\d*(?:-(beta)\.[1-9]\d*)?)$/;

export function webReleaseMetadata(
    tag: string,
    repository: string,
    sha: string
) {
    const match = WEB_TAG.exec(tag);
    if (!match || match[1].length > 128) {
        throw new Error(
            'Expected a release tag such as v2.32.0-web.1 or v2.32.0-web.1-beta.1'
        );
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
        sha_tag: `sha-${sha}`,
        channel: match[2] ?? 'latest'
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

type CiRun = {
    id: number;
    run_attempt: number;
    head_sha: string;
    head_branch: string;
    event: string;
    status: string;
    conclusion: string | null;
};

export async function reusableCiChecks(
    repository: string,
    sha: string,
    token: string
) {
    const fallback = { frontend: false, web: false, desktop: false };
    const api = `https://api.github.com/repos/${repository}/actions`;
    async function get<T>(endpoint: string): Promise<T> {
        const response = await fetch(`${api}/${endpoint}`, {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            redirect: 'error',
            signal: AbortSignal.timeout(15_000)
        });
        if (!response.ok) throw new Error(`GitHub API HTTP ${response.status}`);
        return (await response.json()) as T;
    }

    const query = new URLSearchParams({
        event: 'push',
        branch: 'master',
        head_sha: sha,
        per_page: '1'
    });
    const deadline = Date.now() + 20 * 60_000;
    try {
        for (let attempt = 0; Date.now() < deadline; attempt++) {
            const runs: { workflow_runs: CiRun[] } = await get(
                `workflows/ci.yml/runs?${query}`
            );
            const run = runs.workflow_runs[0];
            if (!run) {
                // A tag pushed with master can arrive before the CI run appears.
                if (attempt > 0) return fallback;
            } else {
                if (
                    run.head_sha !== sha ||
                    run.head_branch !== 'master' ||
                    run.event !== 'push'
                ) {
                    return fallback;
                }
                if (run.status === 'completed') {
                    if (run.conclusion !== 'success') return fallback;
                    const result: {
                        jobs: { name: string; conclusion: string | null }[];
                    } = await get(
                        `runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`
                    );
                    const passed = new Set(
                        result.jobs
                            .filter((job) => job.conclusion === 'success')
                            .map((job) => job.name)
                    );
                    console.log(
                        `Using CI results from https://github.com/${repository}/actions/runs/${run.id}`
                    );
                    return {
                        frontend: passed.has('Web Frontend Checks'),
                        web: passed.has('Web Rust Checks'),
                        desktop: passed.has('Desktop Runtime Compatibility')
                    };
                }
                if (attempt === 0) {
                    console.log(`Waiting for master CI run ${run.id}`);
                }
            }
            await new Promise((resolve) => setTimeout(resolve, 30_000));
        }
    } catch (error) {
        console.warn(
            'Could not verify master CI results:',
            error instanceof Error ? error.message : 'request failed'
        );
    }
    return fallback;
}

function writeOutputs(values: Record<string, string | boolean>): void {
    const output = Object.entries(values)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');
    console.log(output);
    if (process.env.GITHUB_OUTPUT) {
        fs.appendFileSync(process.env.GITHUB_OUTPUT, `${output}\n`);
    }
}

async function main() {
    const repository = process.env.GITHUB_REPOSITORY ?? '';
    const sha = process.env.GITHUB_SHA ?? '';
    const release = webReleaseMetadata(
        process.env.GITHUB_REF_NAME ?? '',
        repository,
        sha
    );
    switch (process.argv[2]) {
        case 'metadata':
            writeOutputs(release);
            break;
        case 'ci-checks':
            writeOutputs(
                await reusableCiChecks(
                    repository,
                    sha,
                    process.env.GH_TOKEN ?? ''
                )
            );
            break;
        case 'check-unpublished':
            await assertUnpublished(
                release,
                process.env.GITHUB_ACTOR ?? '',
                process.env.GH_TOKEN ?? ''
            );
            break;
        default:
            throw new Error(
                'Usage: web-release.ts metadata|ci-checks|check-unpublished'
            );
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

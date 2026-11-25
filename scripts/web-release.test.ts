import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    assertUnpublished,
    reusableCiChecks,
    webReleaseMetadata
} from './web-release';

const sha = 'a'.repeat(40);
const release = webReleaseMetadata('v2.32.0-web.1', 'E-larex/VRCX-docker', sha);

afterEach(() => vi.unstubAllGlobals());

describe('Web release metadata', () => {
    it('normalizes the image name and treats the Web revision as a release', () => {
        expect(release).toEqual({
            image: 'ghcr.io/e-larex/vrcx-docker',
            version: '2.32.0-web.1',
            sha_tag: `sha-${sha}`,
            channel: 'latest'
        });
        expect(
            webReleaseMetadata('v2.32.0-web.10', 'owner/repo', sha).version
        ).toBe('2.32.0-web.10');
    });

    it.each([1, 2, 10])('routes beta.%s to the beta channel', (revision) => {
        expect(
            webReleaseMetadata(
                `v2.32.0-web.1-beta.${revision}`,
                'E-larex/VRCX-docker',
                sha
            )
        ).toEqual({
            image: 'ghcr.io/e-larex/vrcx-docker',
            version: `2.32.0-web.1-beta.${revision}`,
            sha_tag: `sha-${sha}`,
            channel: 'beta'
        });
    });

    it.each([
        'v2.32.0',
        'v2.32.0-beta.1',
        '2.32.0-web.1',
        'v2.32.0-web.0',
        'v2.32.0-web.01',
        'v02.32.0-web.1',
        'v2.32.0-web.1-beta',
        'v2.32.0-web.1-beta.0',
        'v2.32.0-web.1-beta.01',
        'v2.32.0-web.1-beta.1.1',
        'v2.32.0-web.1-alpha.1',
        'v2.32.0-web.1-beta.1\nlatest=true',
        'v2.32.0-web.1\nlatest=true',
        'v2.32.0-web.1/extra'
    ])('rejects invalid or upstream-only tag %s', (tag) => {
        expect(() => webReleaseMetadata(tag, 'owner/repo', sha)).toThrow();
    });

    it('rejects invalid repository names and abbreviated commits', () => {
        expect(() =>
            webReleaseMetadata('v2.32.0-web.1', '../repo', sha)
        ).toThrow();
        expect(() =>
            webReleaseMetadata('v2.32.0-web.1', 'owner/repo', 'abc123')
        ).toThrow();
    });
});

describe('published version protection', () => {
    function registry(status: number) {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce(Response.json({ token: 'registry-token' }))
            .mockResolvedValueOnce(new Response(null, { status }));
        vi.stubGlobal('fetch', fetchMock);
        return fetchMock;
    }

    it('allows only a confirmed missing manifest', async () => {
        const fetchMock = registry(404);
        await expect(
            assertUnpublished(release, 'actor', 'github-token')
        ).resolves.toBeUndefined();
        expect(fetchMock).toHaveBeenLastCalledWith(
            'https://ghcr.io/v2/e-larex/vrcx-docker/manifests/2.32.0-web.1',
            expect.objectContaining({ method: 'HEAD' })
        );
    });

    it('refuses to replace an existing version', async () => {
        registry(200);
        await expect(
            assertUnpublished(release, 'actor', 'github-token')
        ).rejects.toThrow('Refusing to overwrite');
    });

    it.each([401, 403, 429, 500, 503])(
        'fails closed on registry HTTP %s',
        async (status) => {
            registry(status);
            await expect(
                assertUnpublished(release, 'actor', 'github-token')
            ).rejects.toThrow(`HTTP ${status}`);
        }
    );

    it('does not interpret an authentication failure as a missing image', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValue(new Response(null, { status: 403 }));
        vi.stubGlobal('fetch', fetchMock);
        await expect(
            assertUnpublished(release, 'actor', 'github-token')
        ).rejects.toThrow('authentication failed');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('rejects malformed credentials and propagates network failures', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({})));
        await expect(
            assertUnpublished(release, 'actor', 'github-token')
        ).rejects.toThrow('registry token');
        vi.stubGlobal(
            'fetch',
            vi.fn().mockRejectedValue(new Error('Network unavailable'))
        );
        await expect(
            assertUnpublished(release, 'actor', 'github-token')
        ).rejects.toThrow('Network unavailable');
    });
});

describe('release checks covered by master CI', () => {
    const run = {
        id: 42,
        run_attempt: 2,
        head_sha: sha,
        head_branch: 'master',
        event: 'push',
        status: 'completed',
        conclusion: 'success'
    };
    const none = { frontend: false, web: false, desktop: false };
    const check = () => reusableCiChecks('owner/repo', sha, 'test-token');
    afterEach(() => vi.useRealTimers());

    it('uses successful jobs from the matching workflow attempt and reruns skipped checks', async () => {
        const api = vi
            .fn()
            .mockResolvedValueOnce(Response.json({ workflow_runs: [run] }))
            .mockResolvedValueOnce(
                Response.json({
                    jobs: [
                        { name: 'Web Frontend Checks', conclusion: 'success' },
                        { name: 'Web Rust Checks', conclusion: 'skipped' },
                        {
                            name: 'Desktop Runtime Compatibility',
                            conclusion: 'success'
                        }
                    ]
                })
            );
        vi.stubGlobal('fetch', api);
        expect(await check()).toEqual({
            frontend: true,
            web: false,
            desktop: true
        });
        expect(api.mock.calls[0]?.[0]).toBe(
            `https://api.github.com/repos/owner/repo/actions/workflows/ci.yml/runs?event=push&branch=master&head_sha=${sha}&per_page=1`
        );
        expect(api.mock.calls[1]?.[0]).toBe(
            'https://api.github.com/repos/owner/repo/actions/runs/42/attempts/2/jobs?per_page=100'
        );
    });

    it.each([
        { head_sha: 'b'.repeat(40) },
        { head_branch: 'other' },
        { event: 'pull_request' },
        { conclusion: 'failure' },
        { conclusion: 'cancelled' }
    ])('runs release checks for an ineligible result %j', async (override) => {
        const api = vi
            .fn()
            .mockResolvedValueOnce(
                Response.json({ workflow_runs: [{ ...run, ...override }] })
            );
        vi.stubGlobal('fetch', api);
        expect(await check()).toEqual(none);
        expect(api).toHaveBeenCalledTimes(1);
    });

    it('waits for a CI run started at the same time as the tag', async () => {
        vi.useFakeTimers();
        const api = vi
            .fn()
            .mockResolvedValueOnce(Response.json({ workflow_runs: [] }))
            .mockResolvedValueOnce(
                Response.json({
                    workflow_runs: [
                        { ...run, status: 'in_progress', conclusion: null }
                    ]
                })
            )
            .mockResolvedValueOnce(Response.json({ workflow_runs: [run] }))
            .mockResolvedValueOnce(
                Response.json({
                    jobs: [{ name: 'Web Rust Checks', conclusion: 'success' }]
                })
            );
        vi.stubGlobal('fetch', api);
        const result = check();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(await result).toEqual({ ...none, web: true });
    });

    it.each(['missing', 'timeout', 'api error'])(
        'falls back to release checks on %s',
        async (scenario) => {
            vi.useFakeTimers();
            vi.stubGlobal(
                'fetch',
                vi.fn(async () =>
                    scenario === 'api error'
                        ? new Response(null, { status: 503 })
                        : Response.json({
                              workflow_runs:
                                  scenario === 'missing'
                                      ? []
                                      : [
                                            {
                                                ...run,
                                                status: 'queued',
                                                conclusion: null
                                            }
                                        ]
                          })
                )
            );
            const result = check();
            await vi.runAllTimersAsync();
            expect(await result).toEqual(none);
        }
    );
});

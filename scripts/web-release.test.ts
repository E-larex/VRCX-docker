import { afterEach, describe, expect, it, vi } from 'vitest';

import { assertUnpublished, webReleaseMetadata } from './web-release';

const sha = 'a'.repeat(40);
const release = webReleaseMetadata('v2.32.0-web.1', 'E-larex/VRCX-docker', sha);

afterEach(() => vi.unstubAllGlobals());

describe('Web release metadata', () => {
    it('normalizes the image name and treats the Web revision as a release', () => {
        expect(release).toEqual({
            image: 'ghcr.io/e-larex/vrcx-docker',
            version: '2.32.0-web.1',
            sha_tag: `sha-${sha}`
        });
        expect(
            webReleaseMetadata('v2.32.0-web.10', 'owner/repo', sha).version
        ).toBe('2.32.0-web.10');
    });

    it.each([
        'v2.32.0',
        'v2.32.0-beta.1',
        '2.32.0-web.1',
        'v2.32.0-web.0',
        'v2.32.0-web.01',
        'v02.32.0-web.1',
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

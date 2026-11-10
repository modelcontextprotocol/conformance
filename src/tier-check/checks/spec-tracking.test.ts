import { describe, it, expect, vi, afterEach } from 'vitest';
import { Octokit } from '@octokit/rest';
import { checkSpecTracking } from './spec-tracking';

const SPEC_OWNER = 'modelcontextprotocol';
const SPEC_REPO = 'modelcontextprotocol';
const SDK_OWNER = 'modelcontextprotocol';
const SDK_REPO = 'typescript-sdk';

const DAY_MS = 1000 * 60 * 60 * 24;

function isoDaysAfter(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() + days * DAY_MS).toISOString();
}

function notFound(tag: string): Error {
  return Object.assign(new Error(`Not Found: ${tag}`), { status: 404 });
}

function apiError(): Error {
  return new Error('service unavailable');
}

function release(overrides: {
  tag_name: string;
  published_at?: string | null;
  created_at?: string | null;
  draft?: boolean;
  prerelease?: boolean;
}) {
  return {
    tag_name: overrides.tag_name,
    published_at: overrides.published_at ?? null,
    created_at: overrides.created_at ?? overrides.published_at ?? null,
    draft: overrides.draft ?? false,
    prerelease: overrides.prerelease ?? false
  };
}

/**
 * Builds a fake Octokit exposing only the methods checkSpecTracking uses.
 * `getReleaseByTag` is routed by (owner, repo, tag) via the provided maps.
 */
function makeOctokit(opts: {
  getReleaseByTag?: Record<string, unknown | Error>;
  specListReleases?: unknown[] | Error;
  sdkListReleases?: unknown[] | Error;
}): Octokit {
  const getReleaseByTag = vi.fn(
    async ({
      owner,
      repo,
      tag
    }: {
      owner: string;
      repo: string;
      tag: string;
    }) => {
      const key = `${owner}/${repo}@${tag}`;
      const entry = opts.getReleaseByTag?.[key];
      if (entry === undefined) {
        throw new Error(`unexpected getReleaseByTag call: ${key}`);
      }
      if (entry instanceof Error) throw entry;
      return { data: entry };
    }
  );

  const listReleases = vi.fn(
    async ({ owner, repo }: { owner: string; repo: string }) => {
      const isSpec = owner === SPEC_OWNER && repo === SPEC_REPO;
      const source = isSpec ? opts.specListReleases : opts.sdkListReleases;
      if (source instanceof Error) throw source;
      return { data: source ?? [] };
    }
  );

  return {
    repos: { getReleaseByTag, listReleases }
  } as unknown as Octokit;
}

describe('checkSpecTracking — submitted mode (pinned spec + sdk tags)', () => {
  const specTag = '2025-11-25';
  const sdkTag = 'v1.4.0';
  const specPublishedAt = '2025-11-25T00:00:00.000Z';

  function octokitForGap(gapDays: number) {
    return makeOctokit({
      getReleaseByTag: {
        [`${SPEC_OWNER}/${SPEC_REPO}@${specTag}`]: release({
          tag_name: specTag,
          published_at: specPublishedAt
        }),
        [`${SDK_OWNER}/${SDK_REPO}@${sdkTag}`]: release({
          tag_name: sdkTag,
          published_at: isoDaysAfter(specPublishedAt, gapDays)
        })
      }
    });
  }

  it('passes at gap 0 (sdk released exactly on the spec date)', async () => {
    const result = await checkSpecTracking(
      octokitForGap(0),
      SDK_OWNER,
      SDK_REPO,
      { specVersion: specTag, sdkReleaseTag: sdkTag }
    );
    expect(result.status).toBe('pass');
    expect(result.days_gap).toBe(0);
    expect(result.meets_tier1_window).toBe(true);
    expect(result.meets_tier2_window).toBe(true);
  });

  it('passes at a negative gap (sdk released before the spec)', async () => {
    const result = await checkSpecTracking(
      octokitForGap(-5),
      SDK_OWNER,
      SDK_REPO,
      { specVersion: specTag, sdkReleaseTag: sdkTag }
    );
    expect(result.status).toBe('pass');
    expect(result.days_gap).toBe(-5);
    expect(result.meets_tier1_window).toBe(true);
    expect(result.meets_tier2_window).toBe(true);
  });

  it('is partial at gap 1', async () => {
    const result = await checkSpecTracking(
      octokitForGap(1),
      SDK_OWNER,
      SDK_REPO,
      { specVersion: specTag, sdkReleaseTag: sdkTag }
    );
    expect(result.status).toBe('partial');
    expect(result.days_gap).toBe(1);
    expect(result.meets_tier1_window).toBe(false);
    expect(result.meets_tier2_window).toBe(true);
  });

  it('is partial at exactly gap 183 (six months, SEP-1730 Tier 2 window)', async () => {
    const result = await checkSpecTracking(
      octokitForGap(183),
      SDK_OWNER,
      SDK_REPO,
      { specVersion: specTag, sdkReleaseTag: sdkTag }
    );
    expect(result.status).toBe('partial');
    expect(result.days_gap).toBe(183);
    expect(result.meets_tier1_window).toBe(false);
    expect(result.meets_tier2_window).toBe(true);
  });

  it('fails at gap 184', async () => {
    const result = await checkSpecTracking(
      octokitForGap(184),
      SDK_OWNER,
      SDK_REPO,
      { specVersion: specTag, sdkReleaseTag: sdkTag }
    );
    expect(result.status).toBe('fail');
    expect(result.days_gap).toBe(184);
    expect(result.meets_tier1_window).toBe(false);
    expect(result.meets_tier2_window).toBe(false);
  });

  it('emits target_spec_tag and submitted_sdk_tag on success', async () => {
    const result = await checkSpecTracking(
      octokitForGap(0),
      SDK_OWNER,
      SDK_REPO,
      { specVersion: specTag, sdkReleaseTag: sdkTag }
    );
    expect(result.target_spec_tag).toBe(specTag);
    expect(result.submitted_sdk_tag).toBe(sdkTag);
  });

  it('404s on the submitted sdk tag → fail with a reason naming the tag, both windows false', async () => {
    const octokit = makeOctokit({
      getReleaseByTag: {
        [`${SPEC_OWNER}/${SPEC_REPO}@${specTag}`]: release({
          tag_name: specTag,
          published_at: specPublishedAt
        }),
        [`${SDK_OWNER}/${SDK_REPO}@${sdkTag}`]: notFound(sdkTag)
      }
    });
    const result = await checkSpecTracking(octokit, SDK_OWNER, SDK_REPO, {
      specVersion: specTag,
      sdkReleaseTag: sdkTag
    });
    expect(result.status).toBe('fail');
    expect(result.reason).toContain(sdkTag);
    expect(result.meets_tier1_window).toBe(false);
    expect(result.meets_tier2_window).toBe(false);
    // The spec side had already resolved — that must not be lost.
    expect(result.latest_spec_release).toBe(specPublishedAt);
    expect(result.target_spec_tag).toBe(specTag);
    expect(result.submitted_sdk_tag).toBe(sdkTag);
  });

  it('404s on the pinned spec tag → fail with a reason naming the tag, both windows false', async () => {
    const octokit = makeOctokit({
      getReleaseByTag: {
        [`${SPEC_OWNER}/${SPEC_REPO}@${specTag}`]: notFound(specTag)
      }
    });
    const result = await checkSpecTracking(octokit, SDK_OWNER, SDK_REPO, {
      specVersion: specTag,
      sdkReleaseTag: sdkTag
    });
    expect(result.status).toBe('fail');
    expect(result.reason).toContain(specTag);
    expect(result.meets_tier1_window).toBe(false);
    expect(result.meets_tier2_window).toBe(false);
    expect(result.target_spec_tag).toBe(specTag);
    expect(result.submitted_sdk_tag).toBe(sdkTag);
  });

  it('a generic (non-404) error resolving the pinned spec tag → skipped, tags preserved', async () => {
    const octokit = makeOctokit({
      getReleaseByTag: {
        [`${SPEC_OWNER}/${SPEC_REPO}@${specTag}`]: apiError()
      }
    });
    const result = await checkSpecTracking(octokit, SDK_OWNER, SDK_REPO, {
      specVersion: specTag,
      sdkReleaseTag: sdkTag
    });
    expect(result.status).toBe('skipped');
    expect(result.meets_tier1_window).toBeNull();
    expect(result.meets_tier2_window).toBeNull();
    expect(result.target_spec_tag).toBe(specTag);
    expect(result.submitted_sdk_tag).toBe(sdkTag);
    expect(result.latest_spec_release).toBeNull();
  });

  it('a generic (non-404) error resolving the submitted sdk tag → skipped, tags and resolved spec date preserved', async () => {
    const octokit = makeOctokit({
      getReleaseByTag: {
        [`${SPEC_OWNER}/${SPEC_REPO}@${specTag}`]: release({
          tag_name: specTag,
          published_at: specPublishedAt
        }),
        [`${SDK_OWNER}/${SDK_REPO}@${sdkTag}`]: apiError()
      }
    });
    const result = await checkSpecTracking(octokit, SDK_OWNER, SDK_REPO, {
      specVersion: specTag,
      sdkReleaseTag: sdkTag
    });
    expect(result.status).toBe('skipped');
    expect(result.meets_tier1_window).toBeNull();
    expect(result.meets_tier2_window).toBeNull();
    expect(result.target_spec_tag).toBe(specTag);
    expect(result.submitted_sdk_tag).toBe(sdkTag);
    // The spec side had already resolved when the sdk lookup blew up.
    expect(result.latest_spec_release).toBe(specPublishedAt);
  });

  it('resolves a pinned RC spec tag as-is (no normalization)', async () => {
    const rcTag = '2026-07-28-RC';
    const octokit = makeOctokit({
      getReleaseByTag: {
        [`${SPEC_OWNER}/${SPEC_REPO}@${rcTag}`]: release({
          tag_name: rcTag,
          published_at: '2026-07-28T00:00:00.000Z',
          prerelease: true
        }),
        [`${SDK_OWNER}/${SDK_REPO}@${sdkTag}`]: release({
          tag_name: sdkTag,
          published_at: '2026-07-28T00:00:00.000Z'
        })
      }
    });
    const result = await checkSpecTracking(octokit, SDK_OWNER, SDK_REPO, {
      specVersion: rcTag,
      sdkReleaseTag: sdkTag
    });
    expect(result.status).toBe('pass');
    expect(result.target_spec_tag).toBe(rcTag);
  });

  it('treats a draft release returned for the pinned spec tag as not a valid target', async () => {
    const octokit = makeOctokit({
      getReleaseByTag: {
        [`${SPEC_OWNER}/${SPEC_REPO}@${specTag}`]: release({
          tag_name: specTag,
          published_at: specPublishedAt,
          draft: true
        })
      }
    });
    const result = await checkSpecTracking(octokit, SDK_OWNER, SDK_REPO, {
      specVersion: specTag,
      sdkReleaseTag: sdkTag
    });
    expect(result.status).toBe('fail');
    expect(result.reason).toContain(specTag);
    expect(result.meets_tier1_window).toBe(false);
    expect(result.meets_tier2_window).toBe(false);
    expect(result.target_spec_tag).toBe(specTag);
    expect(result.submitted_sdk_tag).toBe(sdkTag);
  });

  it('treats a draft release returned for the submitted tag as not a valid submission', async () => {
    const octokit = makeOctokit({
      getReleaseByTag: {
        [`${SPEC_OWNER}/${SPEC_REPO}@${specTag}`]: release({
          tag_name: specTag,
          published_at: specPublishedAt
        }),
        [`${SDK_OWNER}/${SDK_REPO}@${sdkTag}`]: release({
          tag_name: sdkTag,
          published_at: specPublishedAt,
          draft: true
        })
      }
    });
    const result = await checkSpecTracking(octokit, SDK_OWNER, SDK_REPO, {
      specVersion: specTag,
      sdkReleaseTag: sdkTag
    });
    expect(result.status).toBe('fail');
    expect(result.reason).toContain(sdkTag);
    expect(result.meets_tier1_window).toBe(false);
    expect(result.meets_tier2_window).toBe(false);
  });

  it('falls back to created_at when the submitted release has no published_at', async () => {
    const octokit = makeOctokit({
      getReleaseByTag: {
        [`${SPEC_OWNER}/${SPEC_REPO}@${specTag}`]: release({
          tag_name: specTag,
          published_at: specPublishedAt
        }),
        [`${SDK_OWNER}/${SDK_REPO}@${sdkTag}`]: release({
          tag_name: sdkTag,
          published_at: null,
          created_at: specPublishedAt
        })
      }
    });
    const result = await checkSpecTracking(octokit, SDK_OWNER, SDK_REPO, {
      specVersion: specTag,
      sdkReleaseTag: sdkTag
    });
    expect(result.status).toBe('pass');
    expect(result.days_gap).toBe(0);
  });

  it('falls back to created_at when the pinned spec release has no published_at', async () => {
    const octokit = makeOctokit({
      getReleaseByTag: {
        [`${SPEC_OWNER}/${SPEC_REPO}@${specTag}`]: release({
          tag_name: specTag,
          published_at: null,
          created_at: specPublishedAt
        }),
        [`${SDK_OWNER}/${SDK_REPO}@${sdkTag}`]: release({
          tag_name: sdkTag,
          published_at: specPublishedAt
        })
      }
    });
    const result = await checkSpecTracking(octokit, SDK_OWNER, SDK_REPO, {
      specVersion: specTag,
      sdkReleaseTag: sdkTag
    });
    expect(result.status).toBe('pass');
    expect(result.days_gap).toBe(0);
    expect(result.latest_spec_release).toBe(specPublishedAt);
  });

  it('sdk_release_within_30d is true at a 30d gap and false at a 31d gap', async () => {
    const at30 = await checkSpecTracking(
      octokitForGap(30),
      SDK_OWNER,
      SDK_REPO,
      { specVersion: specTag, sdkReleaseTag: sdkTag }
    );
    expect(at30.sdk_release_within_30d).toBe(true);
    expect(at30.status).toBe('partial');

    const at31 = await checkSpecTracking(
      octokitForGap(31),
      SDK_OWNER,
      SDK_REPO,
      { specVersion: specTag, sdkReleaseTag: sdkTag }
    );
    expect(at31.sdk_release_within_30d).toBe(false);
    expect(at31.status).toBe('partial');
  });
});

describe('checkSpecTracking — legacy mode (no opts)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const specPublishedAt = '2025-11-25T00:00:00.000Z';

  it('selects the first non-draft SDK release published on/after the spec', async () => {
    const octokit = makeOctokit({
      specListReleases: [
        release({ tag_name: '2025-11-25', published_at: specPublishedAt })
      ],
      // API returns newest-first.
      sdkListReleases: [
        release({
          tag_name: 'v1.6.0',
          published_at: isoDaysAfter(specPublishedAt, 40)
        }),
        release({
          tag_name: 'v1.5.0',
          published_at: isoDaysAfter(specPublishedAt, 10)
        }),
        release({
          tag_name: 'v1.4.0',
          published_at: isoDaysAfter(specPublishedAt, -20)
        })
      ]
    });

    const result = await checkSpecTracking(octokit, SDK_OWNER, SDK_REPO);
    expect(result.latest_sdk_release).toBe(isoDaysAfter(specPublishedAt, 10));
    expect(result.days_gap).toBe(10);
    expect(result.status).toBe('partial');
    expect(result.meets_tier1_window).toBe(false);
    expect(result.meets_tier2_window).toBe(true);
  });

  it('uses days elapsed since the spec when no SDK release follows it (fake timers)', async () => {
    vi.setSystemTime(new Date(isoDaysAfter(specPublishedAt, 200)));

    const octokit = makeOctokit({
      specListReleases: [
        release({ tag_name: '2025-11-25', published_at: specPublishedAt })
      ],
      sdkListReleases: [
        release({
          tag_name: 'v1.4.0',
          published_at: isoDaysAfter(specPublishedAt, -20)
        })
      ]
    });

    const result = await checkSpecTracking(octokit, SDK_OWNER, SDK_REPO);
    expect(result.days_gap).toBe(200);
    expect(result.status).toBe('fail');
    expect(result.meets_tier1_window).toBe(false);
    expect(result.meets_tier2_window).toBe(false);
  });

  it('returns skipped when listReleases throws', async () => {
    const octokit = makeOctokit({
      specListReleases: new Error('network down')
    });

    const result = await checkSpecTracking(octokit, SDK_OWNER, SDK_REPO);
    expect(result.status).toBe('skipped');
    expect(result.meets_tier1_window).toBeNull();
    expect(result.meets_tier2_window).toBeNull();
  });

  it('returns skipped when the sdk listReleases call throws after the spec resolved, preserving latest_spec_release', async () => {
    const octokit = makeOctokit({
      specListReleases: [
        release({ tag_name: '2025-11-25', published_at: specPublishedAt })
      ],
      sdkListReleases: new Error('network down')
    });

    const result = await checkSpecTracking(octokit, SDK_OWNER, SDK_REPO);
    expect(result.status).toBe('skipped');
    expect(result.latest_spec_release).toBe(specPublishedAt);
    expect(result.meets_tier1_window).toBeNull();
    expect(result.meets_tier2_window).toBeNull();
  });

  it('returns skipped with a reason when there are no SDK releases', async () => {
    const octokit = makeOctokit({
      specListReleases: [
        release({ tag_name: '2025-11-25', published_at: specPublishedAt })
      ],
      sdkListReleases: []
    });

    const result = await checkSpecTracking(octokit, SDK_OWNER, SDK_REPO);
    expect(result.status).toBe('skipped');
    expect(result.reason).toBeTruthy();
    expect(result.latest_spec_release).toBe(specPublishedAt);
    expect(result.meets_tier1_window).toBeNull();
    expect(result.meets_tier2_window).toBeNull();
  });
});

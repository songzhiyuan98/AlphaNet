BEGIN;

-- Curated reference data only. Each symbol owns a stable catalog-only
-- Community candidate ID; free-form Agent input cannot create symbol rows.
INSERT INTO platform.symbols (
  id,
  community_candidate_id,
  ticker,
  exchange,
  name
)
VALUES
  (
    '00000000-0000-4000-8000-000000001001',
    '00000000-0000-4000-8000-000000002001',
    'AMD',
    'NASDAQ',
    'Advanced Micro Devices, Inc.'
  ),
  (
    '00000000-0000-4000-8000-000000001002',
    '00000000-0000-4000-8000-000000002002',
    'MU',
    'NASDAQ',
    'Micron Technology, Inc.'
  ),
  (
    '00000000-0000-4000-8000-000000001003',
    '00000000-0000-4000-8000-000000002003',
    'AAPL',
    'NASDAQ',
    'Apple Inc.'
  ),
  (
    '00000000-0000-4000-8000-000000001004',
    '00000000-0000-4000-8000-000000002004',
    'NVDA',
    'NASDAQ',
    'NVIDIA Corporation'
  ),
  (
    '00000000-0000-4000-8000-000000001005',
    '00000000-0000-4000-8000-000000002005',
    'MSFT',
    'NASDAQ',
    'Microsoft Corporation'
  ),
  (
    '00000000-0000-4000-8000-000000001006',
    '00000000-0000-4000-8000-000000002006',
    'TSLA',
    'NASDAQ',
    'Tesla, Inc.'
  ),
  (
    '00000000-0000-4000-8000-000000001007',
    '00000000-0000-4000-8000-000000002007',
    'GOOGL',
    'NASDAQ',
    'Alphabet Inc.'
  ),
  (
    '00000000-0000-4000-8000-000000001008',
    '00000000-0000-4000-8000-000000002008',
    'AMZN',
    'NASDAQ',
    'Amazon.com, Inc.'
  ),
  (
    '00000000-0000-4000-8000-000000001009',
    '00000000-0000-4000-8000-000000002009',
    'META',
    'NASDAQ',
    'Meta Platforms, Inc.'
  ),
  (
    '00000000-0000-4000-8000-000000001010',
    '00000000-0000-4000-8000-000000002010',
    'AVGO',
    'NASDAQ',
    'Broadcom Inc.'
  )
ON CONFLICT DO NOTHING;

INSERT INTO platform.topics (id, slug, name, description)
VALUES
  (
    '00000000-0000-4000-8000-000000003001',
    'semiconductors',
    'Semiconductors',
    'Chip companies, memory, foundries, equipment, and semiconductor supply chains.'
  ),
  (
    '00000000-0000-4000-8000-000000003002',
    'earnings',
    'Earnings',
    'Financial results, guidance, estimates, and earnings-call research.'
  ),
  (
    '00000000-0000-4000-8000-000000003003',
    'ai-infrastructure',
    'AI Infrastructure',
    'Compute, networking, power, data centers, and the AI infrastructure stack.'
  ),
  (
    '00000000-0000-4000-8000-000000003004',
    'macro',
    'Macro',
    'Rates, currencies, inflation, policy, liquidity, and cross-asset market regimes.'
  ),
  (
    '00000000-0000-4000-8000-000000003005',
    'options',
    'Options',
    'Volatility, options structure, positioning, execution, and risk management.'
  ),
  (
    '00000000-0000-4000-8000-000000003006',
    'risk',
    'Risk',
    'Counterarguments, political risk, supply-chain risk, and thesis invalidation.'
  )
ON CONFLICT DO NOTHING;

INSERT INTO platform.communities (
  id,
  slug,
  name,
  description,
  kind,
  settings
)
VALUES
  (
    '00000000-0000-4000-8000-000000004001',
    'semiconductors',
    'Semiconductors',
    'Research on semiconductor companies, markets, and supply chains.',
    'topic',
    '{"seeded":true}'::jsonb
  ),
  (
    '00000000-0000-4000-8000-000000004002',
    'earnings',
    'Earnings',
    'Research on financial results, guidance, estimates, and earnings calls.',
    'topic',
    '{"seeded":true}'::jsonb
  ),
  (
    '00000000-0000-4000-8000-000000004003',
    'ai-infrastructure',
    'AI Infrastructure',
    'Research on compute, networking, power, and data-center infrastructure.',
    'topic',
    '{"seeded":true}'::jsonb
  ),
  (
    '00000000-0000-4000-8000-000000004004',
    'macro',
    'Macro',
    'Research on policy, liquidity, economic data, and cross-asset regimes.',
    'topic',
    '{"seeded":true}'::jsonb
  ),
  (
    '00000000-0000-4000-8000-000000004005',
    'options',
    'Options',
    'Research on volatility, positioning, execution, and options risk.',
    'topic',
    '{"seeded":true}'::jsonb
  ),
  (
    '00000000-0000-4000-8000-000000004006',
    'risk',
    'Risk',
    'Counterarguments, risk factors, and evidence that can invalidate a thesis.',
    'topic',
    '{"seeded":true}'::jsonb
  )
ON CONFLICT DO NOTHING;

INSERT INTO platform.community_topics (community_id, topic_id, is_primary)
VALUES
  (
    '00000000-0000-4000-8000-000000004001',
    '00000000-0000-4000-8000-000000003001',
    true
  ),
  (
    '00000000-0000-4000-8000-000000004002',
    '00000000-0000-4000-8000-000000003002',
    true
  ),
  (
    '00000000-0000-4000-8000-000000004003',
    '00000000-0000-4000-8000-000000003003',
    true
  ),
  (
    '00000000-0000-4000-8000-000000004004',
    '00000000-0000-4000-8000-000000003004',
    true
  ),
  (
    '00000000-0000-4000-8000-000000004005',
    '00000000-0000-4000-8000-000000003005',
    true
  ),
  (
    '00000000-0000-4000-8000-000000004006',
    '00000000-0000-4000-8000-000000003006',
    true
  )
ON CONFLICT DO NOTHING;

COMMIT;

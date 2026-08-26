import type {
  GlamaListResponse,
  RegistryListResponse,
  SmitheryListResponse,
} from './types.js';

export function validateOfficialPage(data: unknown): asserts data is RegistryListResponse {
  if (!data || typeof data !== 'object') throw new Error('Registry API: response must be an object');
  const page = data as Partial<RegistryListResponse>;
  if (!Array.isArray(page.servers)) throw new Error('Registry API: servers must be an array');
  if (!page.metadata || typeof page.metadata !== 'object') {
    throw new Error('Registry API: metadata must be an object');
  }
  if (!Number.isInteger(page.metadata.count) || page.metadata.count < 0) {
    throw new Error('Registry API: metadata.count must be a non-negative integer');
  }
  if (page.metadata.count !== page.servers.length) {
    throw new Error(
      `Registry API: metadata.count ${page.metadata.count} does not match ` +
        `${page.servers.length} servers on this page`,
    );
  }
  const cursor = page.metadata.nextCursor;
  if (cursor !== undefined && cursor !== null && typeof cursor !== 'string') {
    throw new Error('Registry API: metadata.nextCursor must be a string, null, or omitted');
  }
}

export function validateGlamaPage(data: unknown): asserts data is GlamaListResponse {
  if (!data || typeof data !== 'object') throw new Error('Glama API: response must be an object');
  const page = data as Partial<GlamaListResponse>;
  if (!Array.isArray(page.servers)) throw new Error('Glama API: servers must be an array');
  if (!page.pageInfo || typeof page.pageInfo !== 'object') {
    throw new Error('Glama API: pageInfo must be an object');
  }
  if (typeof page.pageInfo.hasNextPage !== 'boolean') {
    throw new Error('Glama API: pageInfo.hasNextPage must be boolean');
  }
  if (
    page.pageInfo.hasNextPage &&
    (typeof page.pageInfo.endCursor !== 'string' || page.pageInfo.endCursor.length === 0)
  ) {
    throw new Error('Glama API: pageInfo.endCursor is required when hasNextPage is true');
  }
}

export function validateSmitheryPage(
  data: unknown,
  requestedPage: number,
  pageLimit: number,
): asserts data is SmitheryListResponse {
  if (!data || typeof data !== 'object') {
    throw new Error('Smithery API: response must be an object');
  }
  const result = data as Partial<SmitheryListResponse>;
  if (!Array.isArray(result.servers)) throw new Error('Smithery API: servers must be an array');
  const pagination = result.pagination;
  if (!pagination || typeof pagination !== 'object') {
    throw new Error('Smithery API: pagination must be an object');
  }
  for (const field of ['currentPage', 'pageSize', 'totalPages', 'totalCount'] as const) {
    if (!Number.isInteger(pagination[field]) || pagination[field] < 0) {
      throw new Error(`Smithery API: pagination.${field} must be a non-negative integer`);
    }
  }
  if (pagination.currentPage !== requestedPage) {
    throw new Error(
      `Smithery API: pagination.currentPage ${pagination.currentPage} does not match ${requestedPage}`,
    );
  }
  if (result.servers.length > pageLimit) {
    throw new Error('Smithery API: servers length exceeds requested page limit');
  }
}

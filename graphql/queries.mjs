// ────────────────────────────────────────────────────────────────
// All Shopify GraphQL queries used by this Lambda.
// ────────────────────────────────────────────────────────────────

// Fetch the bulk operation node by its GID — get downloadable JSONL URL.
export const GET_BULK_OPERATION_QUERY = `
  query GetBulkOperation($id: ID!) {
    node(id: $id) {
      ... on BulkOperation {
        id
        status
        errorCode
        type
        url
        objectCount
        fileSize
        partialDataUrl
        createdAt
        completedAt
      }
    }
  }
`;

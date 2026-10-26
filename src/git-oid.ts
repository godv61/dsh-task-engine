/** Git identities are canonical full OIDs after host Git has resolved user input. */
export const isFullOid = (value: string): boolean => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu.test(value)
export const isOidInput = (value: string): boolean => /^[0-9a-f]{7,64}$/iu.test(value)

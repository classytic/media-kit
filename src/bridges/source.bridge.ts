/**
 * SourceBridge — polymorphic reference resolution.
 *
 * Media assets are often attached to other entities (products, articles, users).
 * Rather than hardcoding ObjectId refs (which fail for microservices, external
 * systems, or UUID-backed tables — see PACKAGE_RULES §7), media-kit stores
 * `sourceId: String` + `sourceModel: String` and delegates resolution to a
 * host-implemented bridge.
 *
 * @example
 * ```typescript
 * // Host implementation (same-DB case)
 * const sourceBridge: SourceBridge = {
 *   async resolve(sourceId, sourceModel) {
 *     const Model = mongoose.connection.models[sourceModel];
 *     return Model ? await Model.findById(sourceId).lean() : null;
 *   },
 *   async resolveMany(refs) {
 *     const byModel = new Map<string, string[]>();
 *     for (const { sourceId, sourceModel } of refs) {
 *       const ids = byModel.get(sourceModel) ?? [];
 *       ids.push(sourceId);
 *       byModel.set(sourceModel, ids);
 *     }
 *     const result = new Map<string, unknown>();
 *     for (const [modelName, ids] of byModel) {
 *       const Model = mongoose.connection.models[modelName];
 *       if (!Model) continue;
 *       const docs = await Model.find({ _id: { $in: ids } }).lean();
 *       for (const doc of docs) result.set(String(doc._id), doc);
 *     }
 *     return result;
 *   },
 * };
 *
 * // Host implementation (microservice case)
 * const sourceBridge: SourceBridge = {
 *   async resolve(sourceId, sourceModel) {
 *     if (sourceModel === 'Order') {
 *       return await fetch(`http://orders-svc/${sourceId}`).then(r => r.json());
 *     }
 *     if (sourceModel === 'StripeCharge') {
 *       return await stripe.charges.retrieve(sourceId);
 *     }
 *     return null;
 *   },
 * };
 * ```
 */

/** Polymorphic reference — sourceId + sourceModel pair. */
export interface SourceRef {
  /** Opaque source identifier (ObjectId hex, UUID, Stripe ID, REST ID, etc.) */
  sourceId: string;
  /** Source entity type (e.g. 'Product', 'Order', 'StripeCharge'). */
  sourceModel: string;
}

/** Resolver function signature — maps refs to their source documents. */
export type SourceResolver = (
  refs: SourceRef[],
  ctx?: { organizationId?: string; userId?: string },
) => Promise<Map<string, unknown>>;

/**
 * Host-implemented bridge for polymorphic source resolution.
 * Both `resolve` and `resolveMany` are optional — implement whichever
 * matches your use case. `resolveMany` is preferred for batch endpoints
 * to avoid N+1.
 */
export interface SourceBridge {
  /** Resolve a single (sourceId, sourceModel) ref to its source document. */
  resolve?(
    sourceId: string,
    sourceModel: string,
    ctx?: { organizationId?: string; userId?: string },
  ): Promise<unknown | null>;
  /**
   * Resolve many refs at once (batch-friendly; avoids N+1 in list endpoints).
   * Returns a map keyed by `sourceId`.
   */
  resolveMany?: SourceResolver;
}

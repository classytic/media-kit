/**
 * Arc-compatible Event Transport types.
 *
 * Structurally identical to @classytic/arc's EventTransport.
 * Any arc transport (Memory, Redis, Kafka) drops in without adapters.
 */

export interface DomainEvent<T = unknown> {
  type: string;
  payload: T;
  meta: {
    id: string;
    timestamp: Date;
    resource?: string;
    resourceId?: string;
    userId?: string;
    organizationId?: string;
    correlationId?: string;
  };
}

export type EventHandler<T = unknown> = (event: DomainEvent<T>) => void | Promise<void>;

export interface EventTransport {
  readonly name: string;
  publish(event: DomainEvent): Promise<void>;
  subscribe(pattern: string, handler: EventHandler): Promise<() => void>;
  close?(): Promise<void>;
}

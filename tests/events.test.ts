import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MediaEventEmitter } from '../src/events';

describe('MediaEventEmitter', () => {
  let emitter: MediaEventEmitter;

  beforeEach(() => {
    emitter = new MediaEventEmitter();
  });

  // -----------------------------------------------
  // 1. Basic emit/on: listener receives correct payload
  // -----------------------------------------------
  describe('basic emit/on', () => {
    it('should deliver the correct payload to the listener', async () => {
      const listener = vi.fn();
      emitter.on('after:upload', listener);

      const payload = { id: '123', filename: 'photo.jpg' };
      await emitter.emit('after:upload', payload);

      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith(payload);
    });

    it('should deliver primitive payloads correctly', async () => {
      const listener = vi.fn();
      emitter.on('after:delete', listener);

      await emitter.emit('after:delete', 'file-id-42');

      expect(listener).toHaveBeenCalledWith('file-id-42');
    });
  });

  // -----------------------------------------------
  // 2. Multiple listeners for same event all fire
  // -----------------------------------------------
  describe('multiple listeners', () => {
    it('should call all listeners registered for the same event', async () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      const listener3 = vi.fn();

      emitter.on('after:upload', listener1);
      emitter.on('after:upload', listener2);
      emitter.on('after:upload', listener3);

      const payload = { result: 'ok' };
      await emitter.emit('after:upload', payload);

      expect(listener1).toHaveBeenCalledWith(payload);
      expect(listener2).toHaveBeenCalledWith(payload);
      expect(listener3).toHaveBeenCalledWith(payload);
    });

    it('should call listeners in registration order', async () => {
      const order: number[] = [];

      emitter.on('before:upload', () => { order.push(1); });
      emitter.on('before:upload', () => { order.push(2); });
      emitter.on('before:upload', () => { order.push(3); });

      await emitter.emit('before:upload', {});

      expect(order).toEqual([1, 2, 3]);
    });
  });

  // -----------------------------------------------
  // 3. Async listeners are awaited (emit resolves after all complete)
  // -----------------------------------------------
  describe('async listeners', () => {
    it('should await async listeners before emit() resolves', async () => {
      let completed = false;

      emitter.on('after:upload', async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        completed = true;
      });

      await emitter.emit('after:upload', {});

      expect(completed).toBe(true);
    });

    it('should await multiple async listeners concurrently', async () => {
      const timestamps: number[] = [];

      emitter.on('after:upload', async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        timestamps.push(Date.now());
      });

      emitter.on('after:upload', async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        timestamps.push(Date.now());
      });

      const start = Date.now();
      await emitter.emit('after:upload', {});

      // Both listeners should run concurrently (Promise.allSettled),
      // so total time should be ~50ms, not ~100ms
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(120); // generous threshold for CI
      expect(timestamps).toHaveLength(2);
    });

    it('should handle a mix of sync and async listeners', async () => {
      const results: string[] = [];

      emitter.on('after:upload', () => {
        results.push('sync');
      });

      emitter.on('after:upload', async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
        results.push('async');
      });

      await emitter.emit('after:upload', {});

      expect(results).toContain('sync');
      expect(results).toContain('async');
      expect(results).toHaveLength(2);
    });
  });

  // -----------------------------------------------
  // 4. One failing listener doesn't block others (Promise.allSettled)
  // -----------------------------------------------
  describe('error isolation (Promise.allSettled)', () => {
    it('should not prevent other listeners from running when one throws synchronously', async () => {
      const listener1 = vi.fn();
      const listener3 = vi.fn();

      emitter.on('after:upload', listener1);
      emitter.on('after:upload', () => { throw new Error('boom'); });
      emitter.on('after:upload', listener3);

      // emit() should not throw despite a failing listener
      await expect(emitter.emit('after:upload', {})).resolves.toBeUndefined();

      expect(listener1).toHaveBeenCalledOnce();
      expect(listener3).toHaveBeenCalledOnce();
    });

    it('should not prevent other listeners from running when one rejects asynchronously', async () => {
      const listener1 = vi.fn();
      const listener3 = vi.fn();

      emitter.on('after:upload', listener1);
      emitter.on('after:upload', async () => {
        throw new Error('async boom');
      });
      emitter.on('after:upload', listener3);

      await expect(emitter.emit('after:upload', {})).resolves.toBeUndefined();

      expect(listener1).toHaveBeenCalledOnce();
      expect(listener3).toHaveBeenCalledOnce();
    });

    it('should handle multiple listeners failing simultaneously', async () => {
      const successListener = vi.fn();

      emitter.on('after:upload', () => { throw new Error('fail-1'); });
      emitter.on('after:upload', successListener);
      emitter.on('after:upload', async () => { throw new Error('fail-2'); });

      await expect(emitter.emit('after:upload', {})).resolves.toBeUndefined();

      expect(successListener).toHaveBeenCalledOnce();
    });
  });

  // -----------------------------------------------
  // 5. on() returns unsubscribe function that works
  // -----------------------------------------------
  describe('unsubscribe', () => {
    it('should stop calling the listener after unsubscribe', async () => {
      const listener = vi.fn();
      const unsub = emitter.on('after:upload', listener);

      await emitter.emit('after:upload', { first: true });
      expect(listener).toHaveBeenCalledOnce();

      unsub();

      await emitter.emit('after:upload', { second: true });
      // Should still only have been called once (from the first emit)
      expect(listener).toHaveBeenCalledOnce();
    });

    it('should only unsubscribe the specific listener, not others', async () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();

      const unsub1 = emitter.on('after:upload', listener1);
      emitter.on('after:upload', listener2);

      unsub1();

      await emitter.emit('after:upload', {});

      expect(listener1).not.toHaveBeenCalled();
      expect(listener2).toHaveBeenCalledOnce();
    });

    it('should be safe to call unsubscribe multiple times', () => {
      const listener = vi.fn();
      const unsub = emitter.on('after:upload', listener);

      unsub();
      unsub(); // second call should not throw

      expect(emitter.listenerCount('after:upload')).toBe(0);
    });

    it('should correctly remove the right listener when same function is registered multiple times', async () => {
      const listener = vi.fn();

      const unsub1 = emitter.on('after:upload', listener);
      emitter.on('after:upload', listener);

      expect(emitter.listenerCount('after:upload')).toBe(2);

      unsub1();

      expect(emitter.listenerCount('after:upload')).toBe(1);

      await emitter.emit('after:upload', {});
      expect(listener).toHaveBeenCalledOnce();
    });
  });

  // -----------------------------------------------
  // 6. removeAllListeners() for specific event
  // -----------------------------------------------
  describe('removeAllListeners(event)', () => {
    it('should remove all listeners for the specified event', async () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();

      emitter.on('after:upload', listener1);
      emitter.on('after:upload', listener2);

      expect(emitter.listenerCount('after:upload')).toBe(2);

      emitter.removeAllListeners('after:upload');

      expect(emitter.listenerCount('after:upload')).toBe(0);

      await emitter.emit('after:upload', {});
      expect(listener1).not.toHaveBeenCalled();
      expect(listener2).not.toHaveBeenCalled();
    });

    it('should not affect listeners on other events', async () => {
      const uploadListener = vi.fn();
      const deleteListener = vi.fn();

      emitter.on('after:upload', uploadListener);
      emitter.on('after:delete', deleteListener);

      emitter.removeAllListeners('after:upload');

      expect(emitter.listenerCount('after:upload')).toBe(0);
      expect(emitter.listenerCount('after:delete')).toBe(1);

      await emitter.emit('after:delete', {});
      expect(deleteListener).toHaveBeenCalledOnce();
    });

    it('should not throw when removing listeners for an event with no listeners', () => {
      expect(() => emitter.removeAllListeners('after:upload')).not.toThrow();
    });
  });

  // -----------------------------------------------
  // 7. removeAllListeners() with no arg clears everything
  // -----------------------------------------------
  describe('removeAllListeners() (no argument)', () => {
    it('should remove listeners for all events', async () => {
      const listener1 = vi.fn();
      const listener2 = vi.fn();
      const listener3 = vi.fn();

      emitter.on('after:upload', listener1);
      emitter.on('after:delete', listener2);
      emitter.on('before:move', listener3);

      emitter.removeAllListeners();

      expect(emitter.listenerCount('after:upload')).toBe(0);
      expect(emitter.listenerCount('after:delete')).toBe(0);
      expect(emitter.listenerCount('before:move')).toBe(0);

      await emitter.emit('after:upload', {});
      await emitter.emit('after:delete', {});
      await emitter.emit('before:move', {});

      expect(listener1).not.toHaveBeenCalled();
      expect(listener2).not.toHaveBeenCalled();
      expect(listener3).not.toHaveBeenCalled();
    });

    it('should not throw when there are no listeners at all', () => {
      expect(() => emitter.removeAllListeners()).not.toThrow();
    });
  });

  // -----------------------------------------------
  // 8. listenerCount() returns correct count
  // -----------------------------------------------
  describe('listenerCount', () => {
    it('should return 0 for events with no listeners', () => {
      expect(emitter.listenerCount('after:upload')).toBe(0);
    });

    it('should return the correct count after adding listeners', () => {
      emitter.on('after:upload', vi.fn());
      expect(emitter.listenerCount('after:upload')).toBe(1);

      emitter.on('after:upload', vi.fn());
      expect(emitter.listenerCount('after:upload')).toBe(2);

      emitter.on('after:upload', vi.fn());
      expect(emitter.listenerCount('after:upload')).toBe(3);
    });

    it('should decrease after unsubscribing', () => {
      const unsub1 = emitter.on('after:upload', vi.fn());
      const unsub2 = emitter.on('after:upload', vi.fn());

      expect(emitter.listenerCount('after:upload')).toBe(2);

      unsub1();
      expect(emitter.listenerCount('after:upload')).toBe(1);

      unsub2();
      expect(emitter.listenerCount('after:upload')).toBe(0);
    });

    it('should return 0 after removeAllListeners for that event', () => {
      emitter.on('after:upload', vi.fn());
      emitter.on('after:upload', vi.fn());

      emitter.removeAllListeners('after:upload');

      expect(emitter.listenerCount('after:upload')).toBe(0);
    });

    it('should not count listeners for other events', () => {
      emitter.on('after:upload', vi.fn());
      emitter.on('after:delete', vi.fn());
      emitter.on('after:delete', vi.fn());

      expect(emitter.listenerCount('after:upload')).toBe(1);
      expect(emitter.listenerCount('after:delete')).toBe(2);
    });
  });

  // -----------------------------------------------
  // 9. Emitting event with no listeners is a no-op
  // -----------------------------------------------
  describe('emit with no listeners', () => {
    it('should resolve without throwing when no listeners are registered', async () => {
      await expect(emitter.emit('after:upload', { data: 'test' })).resolves.toBeUndefined();
    });

    it('should resolve without throwing for events that had listeners removed', async () => {
      const listener = vi.fn();
      const unsub = emitter.on('after:upload', listener);
      unsub();

      await expect(emitter.emit('after:upload', {})).resolves.toBeUndefined();
      expect(listener).not.toHaveBeenCalled();
    });

    it('should resolve without throwing after removeAllListeners', async () => {
      emitter.on('after:upload', vi.fn());
      emitter.removeAllListeners('after:upload');

      await expect(emitter.emit('after:upload', {})).resolves.toBeUndefined();
    });
  });

  // -----------------------------------------------
  // 10. Logger receives error info when listener fails
  // -----------------------------------------------
  describe('logger integration', () => {
    it('should call logger.error when a sync listener throws', async () => {
      const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };

      const emitterWithLogger = new MediaEventEmitter(logger);

      emitterWithLogger.on('after:upload', () => {
        throw new Error('sync failure');
      });

      await emitterWithLogger.emit('after:upload', {});

      expect(logger.error).toHaveBeenCalledOnce();
      expect(logger.error).toHaveBeenCalledWith(
        'Event listener error [after:upload]',
        { error: 'sync failure' },
      );
    });

    it('should call logger.error when an async listener rejects', async () => {
      const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };

      const emitterWithLogger = new MediaEventEmitter(logger);

      emitterWithLogger.on('before:delete', async () => {
        throw new Error('async failure');
      });

      await emitterWithLogger.emit('before:delete', {});

      expect(logger.error).toHaveBeenCalledOnce();
      expect(logger.error).toHaveBeenCalledWith(
        'Event listener error [before:delete]',
        { error: 'async failure' },
      );
    });

    it('should call logger.error for each failing listener', async () => {
      const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };

      const emitterWithLogger = new MediaEventEmitter(logger);

      emitterWithLogger.on('after:upload', () => { throw new Error('err-1'); });
      emitterWithLogger.on('after:upload', () => { throw new Error('err-2'); });

      await emitterWithLogger.emit('after:upload', {});

      expect(logger.error).toHaveBeenCalledTimes(2);
      expect(logger.error).toHaveBeenCalledWith(
        'Event listener error [after:upload]',
        { error: 'err-1' },
      );
      expect(logger.error).toHaveBeenCalledWith(
        'Event listener error [after:upload]',
        { error: 'err-2' },
      );
    });

    it('should not throw when no logger is provided and a listener fails', async () => {
      emitter.on('after:upload', () => { throw new Error('no logger'); });

      await expect(emitter.emit('after:upload', {})).resolves.toBeUndefined();
    });

    it('should handle non-Error rejection reasons and stringify them', async () => {
      const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      };

      const emitterWithLogger = new MediaEventEmitter(logger);

      emitterWithLogger.on('after:upload', () => {
        // eslint-disable-next-line no-throw-literal
        throw 'string error';
      });

      await emitterWithLogger.emit('after:upload', {});

      expect(logger.error).toHaveBeenCalledOnce();
      expect(logger.error).toHaveBeenCalledWith(
        'Event listener error [after:upload]',
        { error: 'string error' },
      );
    });
  });

  // -----------------------------------------------
  // 11. Multiple events don't interfere with each other
  // -----------------------------------------------
  describe('event isolation', () => {
    it('should only fire listeners for the emitted event', async () => {
      const uploadListener = vi.fn();
      const deleteListener = vi.fn();
      const moveListener = vi.fn();

      emitter.on('after:upload', uploadListener);
      emitter.on('after:delete', deleteListener);
      emitter.on('before:move', moveListener);

      await emitter.emit('after:upload', { file: 'test.jpg' });

      expect(uploadListener).toHaveBeenCalledOnce();
      expect(deleteListener).not.toHaveBeenCalled();
      expect(moveListener).not.toHaveBeenCalled();
    });

    it('should maintain independent listener lists per event', () => {
      emitter.on('after:upload', vi.fn());
      emitter.on('after:upload', vi.fn());
      emitter.on('after:delete', vi.fn());
      emitter.on('before:move', vi.fn());
      emitter.on('before:move', vi.fn());
      emitter.on('before:move', vi.fn());

      expect(emitter.listenerCount('after:upload')).toBe(2);
      expect(emitter.listenerCount('after:delete')).toBe(1);
      expect(emitter.listenerCount('before:move')).toBe(3);
    });

    it('should not interfere when unsubscribing from one event', async () => {
      const uploadListener = vi.fn();
      const deleteListener = vi.fn();

      const unsub = emitter.on('after:upload', uploadListener);
      emitter.on('after:delete', deleteListener);

      unsub();

      await emitter.emit('after:upload', {});
      await emitter.emit('after:delete', {});

      expect(uploadListener).not.toHaveBeenCalled();
      expect(deleteListener).toHaveBeenCalledOnce();
    });

    it('should support emitting different events sequentially with correct payloads', async () => {
      const uploadListener = vi.fn();
      const deleteListener = vi.fn();

      emitter.on('after:upload', uploadListener);
      emitter.on('after:delete', deleteListener);

      const uploadPayload = { action: 'upload', file: 'a.jpg' };
      const deletePayload = { action: 'delete', id: '42' };

      await emitter.emit('after:upload', uploadPayload);
      await emitter.emit('after:delete', deletePayload);

      expect(uploadListener).toHaveBeenCalledWith(uploadPayload);
      expect(deleteListener).toHaveBeenCalledWith(deletePayload);
    });

    it('should allow the same listener function to be registered on different events independently', async () => {
      const sharedListener = vi.fn();

      emitter.on('after:upload', sharedListener);
      const unsub = emitter.on('after:delete', sharedListener);

      unsub(); // unsubscribe from after:delete only

      await emitter.emit('after:upload', { from: 'upload' });
      await emitter.emit('after:delete', { from: 'delete' });

      expect(sharedListener).toHaveBeenCalledOnce();
      expect(sharedListener).toHaveBeenCalledWith({ from: 'upload' });
    });
  });
});

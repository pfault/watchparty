import { Room } from '../room';
import Redis from 'ioredis';
import axios from 'axios';

let redis = (undefined as unknown) as Redis.Redis;
if (process.env.REDIS_URL) {
  redis = new Redis(process.env.REDIS_URL);
}

export abstract class VMManager {
  constructor(rooms: Map<string, Room>) {
    if (!redis) {
      return;
    }
    const release = async () => {
      // Reset VMs in rooms that are:
      // assigned more than 6 hours ago
      // assigned to a room with no users
      const roomArr = Array.from(rooms.values());
      for (let i = 0; i < roomArr.length; i++) {
        const room = roomArr[i];
        if (room.vBrowser && room.vBrowser.assignTime) {
          if (
            Number(new Date()) - room.vBrowser.assignTime >
              6 * 60 * 60 * 1000 ||
            room.roster.length === 0
          ) {
            console.log('[RESET] VM in room:', room.roomId);
            room.resetRoomVM();
          }
        }
      }
    };
    const renew = async () => {
      const roomArr = Array.from(rooms.values());
      for (let i = 0; i < roomArr.length; i++) {
        const room = roomArr[i];
        if (room.vBrowser && room.vBrowser.id) {
          console.log('[RENEW] VM in room:', room.roomId, room.vBrowser.id);
          // Renew the lock on the VM
          await redis.expire('vbrowser:' + room.vBrowser.id, 300);
        }
      }
    };
    setInterval(this.resizeVMGroupIncr, 15 * 1000);
    setInterval(this.resizeVMGroupDecr, 15 * 60 * 1000);
    setInterval(this.cleanupVMGroup, 60 * 1000);
    setInterval(renew, 30 * 1000);
    setInterval(release, 5 * 60 * 1000);
  }

  assignVM = async () => {
    let selected = null;
    while (!selected) {
      const currSize = await redis.llen('availableList');
      if (currSize === 0) {
        await this.launchVM();
      }
      let resp = await redis.blpop('availableList', 0);
      const id = resp[1];
      console.log('[ASSIGN]', id);
      const lock = await redis.set('vbrowser:' + id, '1', 'NX', 'EX', 300);
      if (!lock) {
        console.log('failed to acquire lock on VM:', id);
        continue;
      }
      let candidate = await this.getVM(id);
      const ready = await this.checkVMReady(candidate.host);
      if (!ready) {
        await this.resetVM(candidate.id);
      } else {
        selected = candidate;
      }
    }
    return selected;
  };

  resizeVMGroupIncr = async () => {
    const maxAvailable = Number(process.env.VBROWSER_VM_BUFFER) || 0;
    const availableCount = await redis.llen('availableList');
    if (availableCount < maxAvailable) {
      console.log(
        '[RESIZE-LAUNCH]',
        'desired:',
        maxAvailable,
        'available:',
        availableCount
      );
      this.launchVM();
    }
  };

  resizeVMGroupDecr = async () => {
    while (true) {
      const maxAvailable = Number(process.env.VBROWSER_VM_BUFFER) || 0;
      const availableCount = await redis.llen('availableList');
      if (availableCount > maxAvailable) {
        const id = await redis.rpop('availableList');
        console.log(
          '[RESIZE-TERMINATE]',
          id,
          'desired:',
          maxAvailable,
          'available:',
          availableCount
        );
        await this.terminateVM(id);
      } else {
        break;
      }
    }
  };

  cleanupVMGroup = async () => {
    // Clean up hanging VMs
    // It's possible we created a VM but lost track of it in redis
    // Take the list of VMs from API, subtract VMs that have a lock in redis or are in the available pool, delete the rest
    const allVMs = await this.listVMs();
    const usedKeys = (await redis.keys('vbrowser:*')).map((key) =>
      key.slice('vbrowser:'.length)
    );
    const availableKeys = await redis.lrange('availableList', 0, -1);
    const dontDelete = new Set([...usedKeys, ...availableKeys]);
    for (let i = 0; i < allVMs.length; i++) {
      const server = allVMs[i];
      if (!dontDelete.has(server.id)) {
        console.log('terminating hanging vm:', server.id);
        this.terminateVM(server.id);
      }
    }
  };

  checkVMReady = async (host: string) => {
    let state = '';
    let retryCount = 0;
    while (!state) {
      // poll for status
      const url = 'https://' + host;
      try {
        const response4 = await axios({
          method: 'GET',
          url,
        });
        state = response4.data.slice(10);
      } catch (e) {
        // console.log(e);
        // console.log(e.response);
        // The server currently 404s on requests with a query string, so just treat the 404 message as success
        // The error code is not 404 maybe due to the gateway
        state =
          e.response && e.response.data === '404 page not found\n'
            ? 'ready'
            : '';
      }
      console.log(retryCount, url, state);
      retryCount += 1;
      if (retryCount >= 50) {
        return false;
      } else {
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
    return true;
  };
  abstract launchVM: () => Promise<VM>;
  abstract resetVM: (id: string) => Promise<void>;
  abstract terminateVM: (id: string) => Promise<void>;
  abstract getVM: (id: string) => Promise<VM>;
  abstract listVMs: (filter?: string) => Promise<VM[]>;
}

export interface VM {
  id: string;
  pass: string;
  host: string;
  private_ip: string;
  state: string;
  tags: string[];
  creation_date: string;
}

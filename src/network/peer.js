import {joinRoom, selfId} from 'trystero/torrent'

const APP_ID = 'sea-of-friends-p2p-game'
const SYNC_HZ = 15

export function createNetwork(roomId) {
  const room = joinRoom({appId: APP_ID}, roomId)

  const [sendState, onState] = room.makeAction('state')

  const callbacks = {
    onPeerJoin: () => {},
    onPeerLeave: () => {},
    onPeerState: () => {},
  }

  room.onPeerJoin((peerId) => {
    callbacks.onPeerJoin(peerId)
  })

  room.onPeerLeave((peerId) => {
    callbacks.onPeerLeave(peerId)
  })

  onState((data, peerId) => {
    callbacks.onPeerState(peerId, data)
  })

  let syncInterval = null

  function startSync(getLocalState) {
    if (syncInterval) clearInterval(syncInterval)
    syncInterval = setInterval(() => {
      sendState(getLocalState())
    }, 1000 / SYNC_HZ)
  }

  function stopSync() {
    if (syncInterval) {
      clearInterval(syncInterval)
      syncInterval = null
    }
  }

  async function leave() {
    stopSync()
    await room.leave()
  }

  function getPeerCount() {
    return Object.keys(room.getPeers()).length
  }

  return {
    selfId,
    room,
    callbacks,
    startSync,
    stopSync,
    leave,
    getPeerCount,
  }
}

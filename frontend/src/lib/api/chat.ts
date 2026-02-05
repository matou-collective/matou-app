/**
 * Chat API Client
 * Handles chat channels and messages API calls
 */

import { BACKEND_URL } from './client';

// --- Types ---

export interface Channel {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  photo?: string;
  createdAt: string;
  createdBy: string;
  isArchived?: boolean;
  allowedRoles?: string[];
  unreadCount?: number;
  lastMessage?: ChatMessage;
}

export interface ChatMessage {
  id: string;
  channelId: string;
  senderAid: string;
  senderName: string;
  content: string;
  attachments?: AttachmentRef[];
  replyTo?: string;
  sentAt: string;
  editedAt?: string;
  deletedAt?: string;
  reactions?: MessageReaction[];
  version: number;
}

export interface AttachmentRef {
  fileRef: string;
  fileName: string;
  contentType: string;
  size: number;
}

export interface MessageReaction {
  emoji: string;
  count: number;
  reactorAids: string[];
  hasReacted: boolean;
}

export interface CreateChannelRequest {
  name: string;
  description?: string;
  icon?: string;
  photo?: string;
  allowedRoles?: string[];
}

export interface UpdateChannelRequest {
  name?: string;
  description?: string;
  icon?: string;
  photo?: string;
  allowedRoles?: string[];
}

export interface SendMessageRequest {
  content: string;
  attachments?: AttachmentRef[];
  replyTo?: string;
}

export interface ListMessagesResponse {
  messages: ChatMessage[];
  count: number;
  nextCursor: string;
  hasMore: boolean;
}

// --- Channel API ---

/**
 * List all chat channels
 */
export async function getChannels(includeArchived = false): Promise<Channel[]> {
  const url = new URL(`${BACKEND_URL}/api/v1/chat/channels`);
  if (includeArchived) {
    url.searchParams.set('includeArchived', 'true');
  }

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Failed to fetch channels: ${response.statusText}`);
  }

  const data = await response.json();
  return data.channels ?? [];
}

/**
 * Get a specific channel by ID
 */
export async function getChannel(channelId: string): Promise<Channel> {
  const response = await fetch(`${BACKEND_URL}/api/v1/chat/channels/${encodeURIComponent(channelId)}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch channel: ${response.statusText}`);
  }
  return response.json();
}

/**
 * Create a new channel (admin only)
 */
export async function createChannel(request: CreateChannelRequest): Promise<{ success: boolean; channelId?: string; error?: string }> {
  try {
    const response = await fetch(`${BACKEND_URL}/api/v1/chat/channels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    return response.json();
  } catch {
    return { success: false, error: 'Network error' };
  }
}

/**
 * Update a channel (admin only)
 */
export async function updateChannel(channelId: string, request: UpdateChannelRequest): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(`${BACKEND_URL}/api/v1/chat/channels/${encodeURIComponent(channelId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    return response.json();
  } catch {
    return { success: false, error: 'Network error' };
  }
}

/**
 * Archive a channel (admin only)
 */
export async function archiveChannel(channelId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(`${BACKEND_URL}/api/v1/chat/channels/${encodeURIComponent(channelId)}`, {
      method: 'DELETE',
    });
    return response.json();
  } catch {
    return { success: false, error: 'Network error' };
  }
}

// --- Message API ---

/**
 * List messages in a channel with pagination
 */
export async function getMessages(
  channelId: string,
  options?: { limit?: number; cursor?: string }
): Promise<ListMessagesResponse> {
  const url = new URL(`${BACKEND_URL}/api/v1/chat/channels/${encodeURIComponent(channelId)}/messages`);
  if (options?.limit) {
    url.searchParams.set('limit', options.limit.toString());
  }
  if (options?.cursor) {
    url.searchParams.set('cursor', options.cursor);
  }

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`Failed to fetch messages: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Send a message to a channel
 */
export async function sendMessage(
  channelId: string,
  request: SendMessageRequest
): Promise<{ success: boolean; messageId?: string; sentAt?: string; error?: string }> {
  try {
    const response = await fetch(`${BACKEND_URL}/api/v1/chat/channels/${encodeURIComponent(channelId)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    return response.json();
  } catch {
    return { success: false, error: 'Network error' };
  }
}

/**
 * Edit a message (owner only)
 */
export async function editMessage(
  messageId: string,
  content: string
): Promise<{ success: boolean; editedAt?: string; error?: string }> {
  try {
    const response = await fetch(`${BACKEND_URL}/api/v1/chat/messages/${encodeURIComponent(messageId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    return response.json();
  } catch {
    return { success: false, error: 'Network error' };
  }
}

/**
 * Delete a message (owner only, soft delete)
 */
export async function deleteMessage(messageId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(`${BACKEND_URL}/api/v1/chat/messages/${encodeURIComponent(messageId)}`, {
      method: 'DELETE',
    });
    return response.json();
  } catch {
    return { success: false, error: 'Network error' };
  }
}

/**
 * Get thread replies for a message
 */
export async function getThread(messageId: string): Promise<{ replies: ChatMessage[]; count: number }> {
  const response = await fetch(`${BACKEND_URL}/api/v1/chat/messages/${encodeURIComponent(messageId)}/thread`);
  if (!response.ok) {
    throw new Error(`Failed to fetch thread: ${response.statusText}`);
  }
  return response.json();
}

// --- Reaction API ---

/**
 * Add a reaction to a message
 */
export async function addReaction(
  messageId: string,
  emoji: string
): Promise<{ success: boolean; count?: number; error?: string }> {
  try {
    const response = await fetch(`${BACKEND_URL}/api/v1/chat/messages/${encodeURIComponent(messageId)}/reactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emoji }),
    });
    return response.json();
  } catch {
    return { success: false, error: 'Network error' };
  }
}

/**
 * Remove a reaction from a message
 */
export async function removeReaction(
  messageId: string,
  emoji: string
): Promise<{ success: boolean; count?: number; error?: string }> {
  try {
    const response = await fetch(
      `${BACKEND_URL}/api/v1/chat/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(emoji)}`,
      { method: 'DELETE' }
    );
    return response.json();
  } catch {
    return { success: false, error: 'Network error' };
  }
}

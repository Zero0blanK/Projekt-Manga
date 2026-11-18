import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const channel = {
  id: 'c1',
  kind: 'discord',
  name: 'My server',
  enabled: true,
  destination: 'discord.com',
  last_sent_at: null,
  last_error: null,
};
const api = vi.hoisted(() => ({
  getNotificationChannels: vi.fn(),
  addNotificationChannel: vi.fn(),
  updateNotificationChannel: vi.fn(),
  removeNotificationChannel: vi.fn(),
  testNotificationChannel: vi.fn(),
}));
vi.mock('@projekt-manga/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@projekt-manga/api-client')>()),
  ...api,
}));

import { ApiError } from '@projekt-manga/api-client';
import { AlertChannels } from '@/components/settings/alert-channels';

describe('alert channels setting', () => {
  it('lists channels by host only and shows a failed test', async () => {
    api.getNotificationChannels.mockResolvedValue([channel]);
    api.testNotificationChannel.mockResolvedValue({ ...channel, last_error: 'HTTP 404' });
    render(<AlertChannels />);
    expect(await screen.findByText('My server')).toBeInTheDocument();
    expect(screen.getByText(/Discord · discord\.com/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Send test' }));
    expect(await screen.findByText(/Last try failed: HTTP 404/)).toBeInTheDocument();
  });

  it('adds a Telegram channel with its token and chat id', async () => {
    api.getNotificationChannels.mockResolvedValue([]);
    api.addNotificationChannel.mockResolvedValue({
      ...channel,
      id: 'c2',
      kind: 'telegram',
      name: 'Telegram',
      destination: 'Telegram',
    });
    render(<AlertChannels />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add a channel' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Telegram' }));
    fireEvent.change(screen.getByLabelText('Bot token'), { target: { value: '1234:abc' } });
    fireEvent.change(screen.getByLabelText('Chat id'), { target: { value: '-100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add channel' }));
    await waitFor(() =>
      expect(api.addNotificationChannel).toHaveBeenCalledWith({
        kind: 'telegram',
        name: 'Telegram',
        token: '1234:abc',
        chat_id: '-100',
      }),
    );
    expect(await screen.findByText(/Telegram · Telegram/)).toBeInTheDocument();
  });

  it("shows the server's reason when a channel is refused", async () => {
    api.getNotificationChannels.mockResolvedValue([]);
    api.addNotificationChannel.mockRejectedValue(
      new ApiError('Must be a Discord webhook URL', 400, 'http'),
    );
    render(<AlertChannels />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add a channel' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Discord' }));
    fireEvent.change(screen.getByLabelText('URL'), { target: { value: 'https://example.com/x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add channel' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Couldn't add the channel. Must be a Discord webhook URL",
    );
  });

  it('can retry when the channels fail to load, rather than calling alerts unsupported', async () => {
    api.getNotificationChannels
      .mockRejectedValueOnce(new ApiError('Unable to reach the server.', 0, 'network'))
      .mockResolvedValue([channel]);
    render(<AlertChannels />);
    expect(await screen.findByText("Alert channels didn't load.")).toBeInTheDocument();
    expect(screen.queryByText(/need a server that supports them/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('My server')).toBeInTheDocument();
  });

  it('says alerts are unsupported only when the server has no such feature', async () => {
    api.getNotificationChannels.mockRejectedValueOnce(new ApiError('Not found', 404, 'http'));
    render(<AlertChannels />);
    expect(await screen.findByText(/need a server that supports them/)).toBeInTheDocument();
  });
});

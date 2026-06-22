import type {
  AppApi,
  ScreenshotAttachment,
  ScreenshotPermissionStatus,
  ScreenshotSource,
} from '../contracts/index.js';

interface CaptureSource {
  id: string;
  name: string;
  thumbnail: { toDataURL(): string; isEmpty?(): boolean };
}

interface ScreenshotDeps {
  permissionStatus(): ScreenshotPermissionStatus;
  getSources(options: {
    types: ('screen' | 'window')[];
    thumbnailSize: { width: number; height: number };
    fetchWindowIcons?: boolean;
  }): Promise<CaptureSource[]>;
  now(): string;
  randomId(): string;
}

const LIST_THUMBNAIL = { width: 360, height: 220 };
const CAPTURE_THUMBNAIL = { width: 2560, height: 1440 };

function sourceKind(id: string): 'screen' | 'window' {
  return id.startsWith('screen:') ? 'screen' : 'window';
}

function assertCapturable(status: ScreenshotPermissionStatus): void {
  if (status === 'denied' || status === 'restricted') {
    throw new Error('Screen recording permission is not available for Canvas Agent.');
  }
}

/** Add Electron-backed screenshot capture to an AppApi without exposing Electron to the renderer. */
export function withScreenshotCapture(api: AppApi, deps: ScreenshotDeps): AppApi {
  const screenshotPermissionStatus = async (): Promise<ScreenshotPermissionStatus> => deps.permissionStatus();

  const listScreenshotSources = async (): Promise<ScreenshotSource[]> => {
    assertCapturable(deps.permissionStatus());
    const sources = await deps.getSources({
      types: ['screen', 'window'],
      thumbnailSize: LIST_THUMBNAIL,
      fetchWindowIcons: true,
    });
    return sources.map((source) => ({
      id: source.id,
      kind: sourceKind(source.id),
      label: source.name,
      thumbnailDataUrl: source.thumbnail.toDataURL(),
    }));
  };

  const captureScreenshot = async (sourceId: string): Promise<ScreenshotAttachment> => {
    assertCapturable(deps.permissionStatus());
    const sources = await deps.getSources({
      types: ['screen', 'window'],
      thumbnailSize: CAPTURE_THUMBNAIL,
      fetchWindowIcons: false,
    });
    const source = sources.find((s) => s.id === sourceId);
    if (!source) throw new Error('Screenshot source is no longer available.');
    if (source.thumbnail.isEmpty?.()) throw new Error('Screenshot source returned an empty image.');
    return {
      id: deps.randomId(),
      kind: 'screenshot',
      mime: 'image/png',
      dataUrl: source.thumbnail.toDataURL(),
      label: source.name,
      capturedAt: deps.now(),
    };
  };

  return {
    ...api,
    screenshotPermissionStatus,
    listScreenshotSources,
    captureScreenshot,
  };
}

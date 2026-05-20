import { useEffect, useMemo, useRef, useState } from 'react';

import { ImageRequest } from '/@/shared/types/domain-types';

type FetchPriority = 'auto' | 'high' | 'low';

interface NativeImageState {
    displaySrc?: string;
    status: 'error' | 'idle' | 'loaded' | 'loading';
}

interface UseNativeImageArgs {
    enabled: boolean;
    fetchPriority?: FetchPriority;
    onFetchError?: () => void;
    request?: ImageRequest | null;
}

export function useNativeImage({
    enabled,
    fetchPriority,
    onFetchError,
    request,
}: UseNativeImageArgs) {
    const abortControllerRef = useRef<AbortController | null>(null);
    const loadedRequestSignatureRef = useRef<null | string>(null);
    const objectUrlRef = useRef<null | string>(null);
    const onFetchErrorRef = useRef(onFetchError);
    const requestRef = useRef(request);
    const [state, setState] = useState<NativeImageState>({ status: 'idle' });

    requestRef.current = request;

    const requestSignature = useMemo(() => {
        if (!request) {
            return null;
        }

        return JSON.stringify({
            cacheKey: request.cacheKey,
            credentials: request.credentials,
            headers: request.headers,
            url: request.url,
        });
    }, [request]);

    onFetchErrorRef.current = onFetchError;

    useEffect(() => {
        const request = requestRef.current;

        const abortCurrentRequest = () => {
            abortControllerRef.current?.abort();
            abortControllerRef.current = null;
        };

        const revokeObjectUrl = () => {
            if (!objectUrlRef.current) {
                return;
            }

            URL.revokeObjectURL(objectUrlRef.current);
            objectUrlRef.current = null;
            loadedRequestSignatureRef.current = null;
        };

        if (!request || !requestSignature) {
            abortCurrentRequest();
            revokeObjectUrl();
            setState((currentState) => {
                if (currentState.status === 'idle' && !currentState.displaySrc) {
                    return currentState;
                }

                return { status: 'idle' };
            });
            return;
        }

        if (!enabled) {
            abortCurrentRequest();
            setState((currentState) => {
                if (currentState.displaySrc) {
                    if (currentState.status === 'loaded') {
                        return currentState;
                    }

                    return { ...currentState, status: 'loaded' };
                }

                if (currentState.status === 'idle' && !currentState.displaySrc) {
                    return currentState;
                }

                return { status: 'idle' };
            });
            return;
        }

        if (loadedRequestSignatureRef.current === requestSignature && objectUrlRef.current) {
            const cachedObjectUrl = objectUrlRef.current;

            setState((currentState) => {
                if (
                    currentState.status === 'loaded' &&
                    currentState.displaySrc === cachedObjectUrl
                ) {
                    return currentState;
                }

                return { displaySrc: cachedObjectUrl, status: 'loaded' };
            });
            return;
        }

        abortCurrentRequest();
        revokeObjectUrl();
        setState((currentState) => {
            if (currentState.status === 'loading' && !currentState.displaySrc) {
                return currentState;
            }

            return { status: 'loading' };
        });

        const abortController = new AbortController();
        abortControllerRef.current = abortController;

        void (async () => {
            try {
                const init = {
                    credentials: request.credentials,
                    headers: request.headers,
                    signal: abortController.signal,
                } as RequestInit & { priority?: FetchPriority };

                if (fetchPriority) {
                    init.priority = fetchPriority;
                }

                const response = await fetch(request.url, init);

                if (!response.ok) {
                    throw new Error(`Failed to load image: ${response.status}`);
                }

                const blob = await response.blob();

                if (abortController.signal.aborted) {
                    return;
                }

                const objectUrl = URL.createObjectURL(blob);
                objectUrlRef.current = objectUrl;
                loadedRequestSignatureRef.current = requestSignature;
                setState({ displaySrc: objectUrl, status: 'loaded' });
            } catch {
                if (abortController.signal.aborted) {
                    return;
                }

                revokeObjectUrl();
                setState({ status: 'error' });
                onFetchErrorRef.current?.();
            } finally {
                if (abortControllerRef.current === abortController) {
                    abortControllerRef.current = null;
                }
            }
        })();

        return () => {
            abortController.abort();

            if (abortControllerRef.current === abortController) {
                abortControllerRef.current = null;
            }
        };
    }, [enabled, fetchPriority, requestSignature]);

    useEffect(() => {
        return () => {
            abortControllerRef.current?.abort();

            if (objectUrlRef.current) {
                URL.revokeObjectURL(objectUrlRef.current);
            }
        };
    }, []);

    return {
        displaySrc: state.displaySrc,
        isError: state.status === 'error',
        isLoaded: state.status === 'loaded',
        isLoading: state.status === 'loading',
    };
}

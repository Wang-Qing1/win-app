import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  VolumeCreateInput,
  VolumeIdInput,
  VolumeListItem,
  VolumeReorderInput,
  VolumeUpdateInput
} from '@shared/modules/volumes'
import { ApiError, getBridge, invoke } from '../../lib/api-client'
import { invalidateLibrary, queryKeys } from '../../lib/query-keys'

export function useVolumeList(bookId: number | null) {
  return useQuery<VolumeListItem[], ApiError>({
    queryKey: queryKeys.volumes.list(bookId ?? -1),
    queryFn: () => invoke(() => getBridge().volumes.list({ bookId: bookId as number })),
    enabled: bookId !== null && bookId > 0
  })
}

export function useCreateVolume() {
  const queryClient = useQueryClient()
  return useMutation<VolumeListItem, ApiError, VolumeCreateInput>({
    mutationFn: (input) => invoke(() => getBridge().volumes.create(input)),
    onSuccess: () => invalidateLibrary(queryClient)
  })
}

export function useUpdateVolume() {
  const queryClient = useQueryClient()
  return useMutation<VolumeListItem, ApiError, VolumeUpdateInput>({
    mutationFn: (input) => invoke(() => getBridge().volumes.update(input)),
    onSuccess: () => invalidateLibrary(queryClient)
  })
}

export function useRemoveVolume() {
  const queryClient = useQueryClient()
  return useMutation<{ id: number; detachedChapters: number }, ApiError, VolumeIdInput>({
    mutationFn: (input) => invoke(() => getBridge().volumes.remove(input)),
    onSuccess: () => invalidateLibrary(queryClient)
  })
}

export function useReorderVolumes() {
  const queryClient = useQueryClient()
  return useMutation<{ bookId: number }, ApiError, VolumeReorderInput>({
    mutationFn: (input) => invoke(() => getBridge().volumes.reorder(input)),
    onSuccess: () => invalidateLibrary(queryClient)
  })
}

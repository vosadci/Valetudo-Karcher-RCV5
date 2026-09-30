import React from "react";
import {
    Alert,
    Box,
    Button,
    Chip,
    CircularProgress,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    IconButton,
    List,
    ListItem,
    ListItemText,
    TextField
} from "@mui/material";
import {CheckCircleOutline as SelectIcon, DeleteOutline as DeleteIcon, Edit as EditIcon} from "@mui/icons-material";
import {useMutation, useQuery, useQueryClient} from "@tanstack/react-query";
import {useSnackbar} from "notistack";
import {valetudoAPI} from "api";

interface SavedMap {
    id: number,
    name: string,
    cur: boolean
}

const QUERY_KEY = ["karcher", "maps"];
const MAX_NAME_LENGTH = 24;

const MapsPage = (): React.ReactElement => {
    const queryClient = useQueryClient();
    const {enqueueSnackbar} = useSnackbar();
    const [renaming, setRenaming] = React.useState<SavedMap | null>(null);
    const [newName, setNewName] = React.useState("");
    const [deleting, setDeleting] = React.useState<SavedMap | null>(null);

    const {data, isPending, error} = useQuery({
        queryKey: QUERY_KEY,
        queryFn: async (): Promise<Array<SavedMap>> => {
            return (await valetudoAPI.get<Array<SavedMap>>("/karcher/maps")).data;
        },
        retry: false
    });

    const renameMutation = useMutation({
        mutationFn: async (args: { id: number, name: string }): Promise<Array<SavedMap>> => {
            return (await valetudoAPI.put<Array<SavedMap>>(`/karcher/maps/${args.id}/name`, {name: args.name})).data;
        },
        onSuccess: (maps) => {
            queryClient.setQueryData(QUERY_KEY, maps);
            setRenaming(null);
            enqueueSnackbar("Map renamed", {variant: "success"});
        },
        onError: (e: Error) => {
            enqueueSnackbar(`Could not rename the map: ${e.message}`, {variant: "error"});
        }
    });

    const selectMutation = useMutation({
        mutationFn: async (id: number): Promise<Array<SavedMap>> => {
            return (await valetudoAPI.put<Array<SavedMap>>(`/karcher/maps/${id}/current`)).data;
        },
        onSuccess: (maps) => {
            queryClient.setQueryData(QUERY_KEY, maps);
            enqueueSnackbar("Map selected", {variant: "success"});
        },
        onError: (e: Error) => {
            enqueueSnackbar(`Could not select the map: ${e.message}`, {variant: "error"});
        }
    });

    const deleteMutation = useMutation({
        mutationFn: async (id: number): Promise<Array<SavedMap>> => {
            return (await valetudoAPI.delete<Array<SavedMap>>(`/karcher/maps/${id}`)).data;
        },
        onSuccess: (maps) => {
            queryClient.setQueryData(QUERY_KEY, maps);
            setDeleting(null);
            enqueueSnackbar("Map deleted", {variant: "success"});
        },
        onError: (e: Error) => {
            setDeleting(null);
            enqueueSnackbar(`Could not delete the map: ${e.message}`, {variant: "error"});
        }
    });

    if (isPending) {
        return <Box sx={{display: "flex", justifyContent: "center", padding: 3}}><CircularProgress/></Box>;
    }

    if (error) {
        return <Alert severity="error" sx={{margin: 1.5}}>Could not load the saved maps: {error.message}</Alert>;
    }

    if (data.length === 0) {
        return <Alert severity="info" sx={{margin: 1.5}}>The robot reports no saved maps.</Alert>;
    }

    const trimmedName = newName.trim();

    return (
        <>
            <List sx={{padding: 1.5}}>
                {data.map((map) => {
                    return (
                        <ListItem
                            key={map.id}
                            secondaryAction={
                                <>
                                    {map.cur && <Chip size="small" color="primary" label="Current" sx={{marginRight: 1}}/>}
                                    {!map.cur && (
                                        <IconButton
                                            aria-label="Use this map"
                                            disabled={selectMutation.isPending}
                                            onClick={() => {
                                                selectMutation.mutate(map.id);
                                            }}
                                        >
                                            <SelectIcon/>
                                        </IconButton>
                                    )}
                                    <IconButton
                                        aria-label="Rename"
                                        onClick={() => {
                                            setNewName(map.name);
                                            setRenaming(map);
                                        }}
                                    >
                                        <EditIcon/>
                                    </IconButton>
                                    {!map.cur && (
                                        <IconButton
                                            aria-label="Delete"
                                            onClick={() => {
                                                setDeleting(map);
                                            }}
                                        >
                                            <DeleteIcon/>
                                        </IconButton>
                                    )}
                                </>
                            }
                        >
                            <ListItemText primary={map.name || `Map ${map.id}`} secondary={`ID ${map.id}`}/>
                        </ListItem>
                    );
                })}
            </List>
            <Dialog open={renaming !== null} onClose={() => {
                setRenaming(null);
            }} fullWidth maxWidth="xs">
                <DialogTitle>Rename map</DialogTitle>
                <DialogContent>
                    <TextField
                        autoFocus
                        fullWidth
                        margin="dense"
                        label="Map name"
                        value={newName}
                        slotProps={{htmlInput: {maxLength: MAX_NAME_LENGTH}}}
                        onChange={(e) => {
                            setNewName(e.target.value);
                        }}
                    />
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => {
                        setRenaming(null);
                    }}>Cancel</Button>
                    <Button
                        variant="contained"
                        disabled={trimmedName.length === 0 || renameMutation.isPending}
                        onClick={() => {
                            if (renaming !== null) {
                                renameMutation.mutate({id: renaming.id, name: trimmedName});
                            }
                        }}
                    >
                        Save
                    </Button>
                </DialogActions>
            </Dialog>
            <Dialog open={deleting !== null} onClose={() => {
                setDeleting(null);
            }} fullWidth maxWidth="xs">
                <DialogTitle>Delete map?</DialogTitle>
                <DialogContent>
                    &quot;{deleting?.name || `Map ${deleting?.id}`}&quot; and its room settings will be removed from the robot. This cannot be undone.
                </DialogContent>
                <DialogActions>
                    <Button onClick={() => {
                        setDeleting(null);
                    }}>Cancel</Button>
                    <Button
                        color="error"
                        variant="contained"
                        disabled={deleteMutation.isPending}
                        onClick={() => {
                            if (deleting !== null) {
                                deleteMutation.mutate(deleting.id);
                            }
                        }}
                    >
                        Delete
                    </Button>
                </DialogActions>
            </Dialog>
        </>
    );
};

export default MapsPage;

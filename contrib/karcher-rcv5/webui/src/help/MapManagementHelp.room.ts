// Hand-written Room wording for frontend/src/options/res/MapManagementHelp.ts, swapped in by build.js.
export const MapManagementHelp = `
## Map Management

This page allows you to do map-related tasks. What exactly can be done here depends on your model of robot as well
as its firmware.<br/>If you don't see something on this page, it is likely not supported by your robot.

Some robots may require you to manually enable persistent maps before you can do most map-related things.
Others may not even allow disabling of persistent maps because why would you.

There are also some legacy robots, which don't feature persistent maps at all.

Some robots may require a full cleanup task including them returning to the dock on their own for a new map to be saved.
Others may either optionally allow for fast mapping via a mapping pass or even require a mapping pass before they can be used.

### Terminology

Please note that all these concepts need firmware support by your robot.
Not everything might be available on every robot. 

#### Rooms

A room is a partition of the map as decided by the robot's firmware.
Rooms enable you to just clean one or more predefined areas. You can also give them names.

A room doesn't necessarily have to be an actual room.
There could for example be a room which is just the area around your dining table.

The robot uses the room data to optimize its navigation and drive the most efficient path.

#### Zones

Zones are just rectangles that you can draw on the map to send the robot there.
Depending on the firmware of your robot, it might accept just one or multiple zones as an input.
`;

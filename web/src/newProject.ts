import { createContext, useContext } from "react";

// One New Project dialog lives in the layout; any page can open it.
export const NewProjectContext = createContext<() => void>(() => {});
export const useOpenNewProject = () => useContext(NewProjectContext);

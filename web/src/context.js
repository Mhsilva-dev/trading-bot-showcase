import { createContext, useContext } from 'react';

export const BotContext = createContext(null);
export const useBot = () => useContext(BotContext);
